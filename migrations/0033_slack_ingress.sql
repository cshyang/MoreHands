-- Verified transport acceptance and preparation ownership. Native Flue owns execution.
CREATE TABLE slack_ingress (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, event_id TEXT NOT NULL, digest TEXT NOT NULL,
  event_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'received' CHECK(state IN ('received','preparing','ready','uncertain','accepted','failed')),
  revision INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_at INTEGER,
  target_json TEXT, manifest_id TEXT, receipt_json TEXT,
  mode TEXT CHECK(mode IN ('quiet','engaged','overhear')), instance_id TEXT, tracker_event_id TEXT,
  effects_complete INTEGER NOT NULL DEFAULT 0 CHECK(effects_complete IN (0,1)),
  file_effects_json TEXT, file_effect_cursor INTEGER NOT NULL DEFAULT 0 CHECK(file_effect_cursor>=0),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  prepare_attempts INTEGER NOT NULL DEFAULT 0 CHECK(prepare_attempts>=0),
  handoff_attempts INTEGER NOT NULL DEFAULT 0 CHECK(handoff_attempts>=0),
  content_retention TEXT NOT NULL DEFAULT 'retained' CHECK(content_retention IN ('retained','tombstoned')),
  failure_category TEXT,
  ack_state TEXT NOT NULL DEFAULT 'none' CHECK(ack_state IN ('none','intent','sending','posted','skipped','rejected','uncertain')),
  ack_json TEXT, ack_message_ts TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(team_id,event_id)
);
CREATE INDEX slack_ingress_recovery ON slack_ingress(state,next_attempt_at,created_at,id);
CREATE TRIGGER slack_ingress_owns_producer AFTER INSERT ON slack_ingress BEGIN
  INSERT INTO cutover_producers(id,source,generation,kind,admitted_at) VALUES(NEW.id,'slack','g2','intake',NEW.created_at);
END;
CREATE TABLE slack_ingress_manifests (
  id TEXT PRIMARY KEY, ingress_id TEXT NOT NULL REFERENCES slack_ingress(id),
  encoding_version INTEGER NOT NULL CHECK(encoding_version=1),
  total_bytes INTEGER NOT NULL CHECK(total_bytes>0 AND total_bytes<=11495904),
  chunk_count INTEGER NOT NULL CHECK(chunk_count>0 AND chunk_count<=12), digest TEXT NOT NULL,
  created_at INTEGER NOT NULL, preparation_owner TEXT NOT NULL, preparation_revision INTEGER NOT NULL
);
CREATE TABLE slack_ingress_chunks (
  manifest_id TEXT NOT NULL REFERENCES slack_ingress_manifests(id),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<12),
  bytes BLOB NOT NULL CHECK(length(bytes)>0 AND length(bytes)<=1000000), digest TEXT NOT NULL,
  PRIMARY KEY(manifest_id,ordinal)
);
CREATE INDEX slack_ingress_manifest_attempts ON slack_ingress_manifests(ingress_id,created_at);

CREATE TRIGGER slack_ingress_identity_immutable BEFORE UPDATE OF id,team_id,event_id,digest,created_at ON slack_ingress
WHEN NEW.id IS NOT OLD.id OR NEW.team_id IS NOT OLD.team_id OR NEW.event_id IS NOT OLD.event_id
  OR NEW.digest IS NOT OLD.digest OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'ingress_identity_guard'); END;
CREATE TRIGGER slack_ingress_route_immutable BEFORE UPDATE OF target_json,mode,instance_id,tracker_event_id ON slack_ingress
WHEN OLD.target_json IS NOT NULL AND (NEW.target_json IS NOT OLD.target_json OR NEW.mode IS NOT OLD.mode
  OR NEW.instance_id IS NOT OLD.instance_id OR NEW.tracker_event_id IS NOT OLD.tracker_event_id)
BEGIN SELECT RAISE(ABORT,'ingress_route_guard'); END;
CREATE TRIGGER slack_ingress_terminal_immutable BEFORE UPDATE ON slack_ingress
WHEN OLD.state='accepted'
BEGIN SELECT RAISE(ABORT,'ingress_terminal_guard'); END;
CREATE TRIGGER slack_ingress_content_guard BEFORE UPDATE OF event_json,content_retention ON slack_ingress
WHEN (NEW.event_json IS NOT OLD.event_json OR NEW.content_retention IS NOT OLD.content_retention)
  AND NOT COALESCE(OLD.state='preparing' AND NEW.state='accepted' AND NEW.mode='quiet'
    AND OLD.lease_owner IS NOT NULL AND OLD.lease_expires_at>NEW.updated_at AND NEW.revision=OLD.revision+1
    AND NEW.effects_complete=1 AND NEW.manifest_id IS NULL AND NEW.receipt_json IS NULL
    AND NEW.event_json='{}' AND NEW.content_retention='tombstoned',0)
BEGIN SELECT RAISE(ABORT,'ingress_content_guard'); END;
CREATE TRIGGER slack_ingress_manifest_immutable BEFORE UPDATE ON slack_ingress_manifests
BEGIN SELECT RAISE(ABORT,'ingress_manifest_guard'); END;
CREATE TRIGGER slack_ingress_chunk_immutable BEFORE UPDATE ON slack_ingress_chunks
BEGIN SELECT RAISE(ABORT,'ingress_chunk_guard'); END;
CREATE TRIGGER slack_ingress_chunk_append_guard BEFORE INSERT ON slack_ingress_chunks
WHEN EXISTS(SELECT 1 FROM slack_ingress WHERE manifest_id=NEW.manifest_id)
BEGIN SELECT RAISE(ABORT,'ingress_chunk_guard'); END;
CREATE TRIGGER slack_ingress_chunk_delete_guard BEFORE DELETE ON slack_ingress_chunks
WHEN EXISTS(SELECT 1 FROM slack_ingress WHERE manifest_id=OLD.manifest_id)
  OR EXISTS(SELECT 1 FROM slack_ingress_manifests m JOIN slack_ingress i ON i.id=m.ingress_id
    WHERE m.id=OLD.manifest_id AND i.state='failed')
BEGIN SELECT RAISE(ABORT,'ingress_retention_guard'); END;
CREATE TRIGGER slack_ingress_manifest_delete_guard BEFORE DELETE ON slack_ingress_manifests
WHEN EXISTS(SELECT 1 FROM slack_ingress WHERE manifest_id=OLD.id)
  OR EXISTS(SELECT 1 FROM slack_ingress WHERE id=OLD.ingress_id AND state='failed')
BEGIN SELECT RAISE(ABORT,'ingress_retention_guard'); END;

-- Successful no-op statements are not rollback. Abort guards enforce the full batch.
-- Keep conditions in WHEN: the remote migration parser truncates CASE ... END
-- inside a trigger body even though local SQLite accepts the complete statement.
CREATE TRIGGER slack_ingress_publication_guard BEFORE UPDATE OF state,manifest_id ON slack_ingress
WHEN NEW.state='ready' AND (OLD.state<>'ready' OR NEW.manifest_id IS NOT OLD.manifest_id)
  AND NOT COALESCE(OLD.state='preparing' AND OLD.lease_owner IS NOT NULL
    AND OLD.lease_expires_at>NEW.updated_at AND NEW.revision=OLD.revision+1
    AND NEW.effects_complete=1 AND NEW.mode IN ('engaged','overhear')
    AND json_valid(NEW.target_json) AND NEW.instance_id IS NOT NULL
    AND NEW.instance_id IS json_extract(NEW.target_json,'$.instanceId')
    AND NEW.mode IS json_extract(NEW.target_json,'$.mode')
    AND NEW.tracker_event_id IS json_extract(NEW.target_json,'$.deliveryEventId')
    AND ((NEW.mode='engaged' AND NEW.ack_state IN ('posted','skipped')) OR (NEW.mode='overhear' AND NEW.ack_state='skipped'))
    AND EXISTS(SELECT 1 FROM slack_ingress_manifests m WHERE m.id=NEW.manifest_id AND m.ingress_id=NEW.id
      AND m.preparation_owner=OLD.lease_owner AND m.preparation_revision=OLD.revision
      AND (SELECT COUNT(*) FROM slack_ingress_chunks c WHERE c.manifest_id=m.id)=m.chunk_count
      AND (SELECT MIN(ordinal) FROM slack_ingress_chunks c WHERE c.manifest_id=m.id)=0
      AND (SELECT MAX(ordinal) FROM slack_ingress_chunks c WHERE c.manifest_id=m.id)=m.chunk_count-1
      AND (SELECT SUM(length(bytes)) FROM slack_ingress_chunks c WHERE c.manifest_id=m.id)=m.total_bytes),0)
BEGIN SELECT RAISE(ABORT,'ingress_publication_guard'); END;

CREATE TRIGGER slack_ingress_completion_guard BEFORE UPDATE OF state ON slack_ingress
WHEN NEW.state='accepted' AND OLD.state<>'accepted'
  AND NOT COALESCE(OLD.lease_owner IS NOT NULL AND OLD.lease_expires_at>NEW.updated_at
    AND NEW.revision=OLD.revision+1 AND NEW.effects_complete=1
    AND json_valid(NEW.target_json) AND NEW.mode IS json_extract(NEW.target_json,'$.mode')
    AND NEW.tracker_event_id IS json_extract(NEW.target_json,'$.deliveryEventId')
    AND EXISTS(SELECT 1 FROM cutover_producers p WHERE p.id=NEW.id AND p.source='slack' AND p.generation='g2' AND p.kind='intake')
    AND ((OLD.state='preparing' AND NEW.mode='quiet' AND NEW.manifest_id IS NULL AND NEW.receipt_json IS NULL
        AND NEW.ack_state='skipped' AND NEW.event_json='{}' AND NEW.content_retention='tombstoned'
        AND NEW.file_effects_json IS NULL AND NEW.file_effect_cursor=0)
      OR (OLD.state IN ('ready','uncertain') AND NEW.mode IN ('engaged','overhear')
        AND NEW.instance_id IS NOT NULL AND NEW.instance_id IS json_extract(NEW.target_json,'$.instanceId')
        AND EXISTS(SELECT 1 FROM slack_ingress_manifests m WHERE m.id=NEW.manifest_id AND m.ingress_id=NEW.id)
        AND json_valid(NEW.receipt_json)
        AND json_type(NEW.receipt_json,'$.submissionId')='text' AND length(json_extract(NEW.receipt_json,'$.submissionId'))>0
        AND json_type(NEW.receipt_json,'$.uid')='text' AND length(json_extract(NEW.receipt_json,'$.uid'))>0
        AND json_type(NEW.receipt_json,'$.acceptedAt')='text' AND length(json_extract(NEW.receipt_json,'$.acceptedAt'))>0
        AND (NEW.mode='overhear' OR EXISTS(SELECT 1 FROM slack_reply_trackers t
          WHERE t.instance_id=NEW.instance_id AND t.event_id=NEW.tracker_event_id
          AND t.target_json IS json_extract(NEW.target_json,'$.target')
          AND t.persona_json IS json_extract(NEW.target_json,'$.persona')
          AND t.ack_message_ts IS NEW.ack_message_ts AND t.publish=1
          AND t.submission_id IS json_extract(NEW.receipt_json,'$.submissionId')
          AND t.uid IS json_extract(NEW.receipt_json,'$.uid'))))),0)
BEGIN SELECT RAISE(ABORT,'ingress_completion_guard'); END;
CREATE TRIGGER slack_ingress_releases_producer AFTER UPDATE OF state ON slack_ingress
WHEN NEW.state='accepted' AND OLD.state<>'accepted'
BEGIN DELETE FROM cutover_producers WHERE id=NEW.id AND source='slack' AND generation='g2' AND kind='intake'; END;
