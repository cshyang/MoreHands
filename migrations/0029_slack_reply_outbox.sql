-- Flue owns answer/history recovery. These rows track only external Slack delivery.
CREATE TABLE slack_reply_outbox (
  delivery_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  response_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  target_json TEXT NOT NULL,
  persona_json TEXT,
  part_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  edit_ts TEXT,
  posted_ts TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','uncertain','sent')),
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(instance_id, response_id, part_index)
);
CREATE INDEX idx_slack_reply_outbox_pending ON slack_reply_outbox(status, lease_until);
