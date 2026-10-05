import * as v from 'valibot';
import { setAdmissionState, type Generation, type CutoverEnv } from './admissions';
import { validCount } from './observation';
import type { D1Like } from '../skills/repository';
import { observationSchema } from './evidence';
import { loadFrozenRequest, FrozenRequestInvalid } from '../slack/frozen-request';
import { requireIngressDb } from '../slack/ingress-store';
export interface DiagnosticNamespace {
  idFromName(name: string): { toString(): string };
  idFromString(id: string): unknown;
  get(id: unknown): { observeCutover(identity: { namespaceId: string; objectId: string }): Promise<unknown> };
}
export interface DiagnosticEnv extends CutoverEnv { CUTOVER_NAMESPACE_ID?: unknown; FLUE_PROJECT_AGENT?: unknown }
const identityRequestSchema = v.strictObject({ namespaceId: v.string(), instanceNames: v.pipe(
  v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1024), v.check(name => name.trim() === name && !/[\u0000-\u001f\u007f]/.test(name)))),
  v.minLength(1), v.maxLength(100), v.check(names => new Set(names).size === names.length),
) });
export async function deriveInstanceIdentities(env: DiagnosticEnv, value: unknown, now = Date.now()): Promise<{ status: number; body: unknown }> {
  const unavailable = { status: 503, body: { error: 'identity derivation unavailable' } };
  if (env.CUTOVER_CONTROL !== 'd1' || typeof env.CUTOVER_NAMESPACE_ID !== 'string'
    || !env.CUTOVER_NAMESPACE_ID.trim() || !env.FLUE_PROJECT_AGENT) return unavailable;
  const parsed = v.safeParse(identityRequestSchema, value);
  if (!parsed.success || parsed.output.namespaceId !== env.CUTOVER_NAMESPACE_ID) {
    return { status: 400, body: { error: 'invalid identity derivation request' } };
  }
  try {
    const namespace = env.FLUE_PROJECT_AGENT as Pick<DiagnosticNamespace, 'idFromName'>;
    // This is derivation only: never obtain a stub or contact object storage.
    const identities = parsed.output.instanceNames.map(instanceName => {
      const objectId = namespace.idFromName(instanceName).toString();
      if (!/^[a-f0-9]{64}$/.test(objectId)) throw new Error('invalid object ID');
      return { instanceName, objectId };
    });
    return { status: 200, body: { namespaceId: env.CUTOVER_NAMESPACE_ID, observedAt: now, identities,
      limitations: ['Name derivation does not establish object existence, persisted runtime, generation, or idle state.'] } };
  } catch { return unavailable; }
}
const entrySchema = v.strictObject({ namespaceId: v.string(), objectId: v.string(), generation: v.picklist(['g1', 'g2']),
  runtimeVersion: v.picklist(['1.0.0-beta.1', '2.2.2']), associationEvidence: v.string(), instanceName: v.optional(v.string()) });
export async function observeAssociatedInstance(env: DiagnosticEnv, generation: Generation, value: unknown): Promise<unknown> {
  const unavailable = { status: 'unknown', blockers: [], unknowns: ['instance association or observation unavailable'],
    limitations: ['Matching-runtime object contact can invoke startup recovery; this is not a passive fleet snapshot.'] };
  const parsed = v.safeParse(entrySchema, value);
  if (!parsed.success) return unavailable;
  const entry = parsed.output;
  if (!env.CUTOVER_NAMESPACE_ID || entry.namespaceId !== env.CUTOVER_NAMESPACE_ID || entry.generation !== generation
    || entry.runtimeVersion !== (generation === 'g1' ? '1.0.0-beta.1' : '2.2.2')
    || !entry.associationEvidence.trim() || !entry.instanceName?.endsWith(`@${generation}`)) return unavailable;
  try {
    const namespace = env.FLUE_PROJECT_AGENT as DiagnosticNamespace | undefined;
    if (!namespace || namespace.idFromName(entry.instanceName).toString() !== entry.objectId) return unavailable;
    // PartyServer resolves the instance name lazily from idFromName; addressing the
    // object with idFromString leaves the name unset and any .name read throws.
    // Use the name-derived stub — identical ID, correct PartyServer bootstrap.
    const result = v.safeParse(observationSchema, await namespace.get(namespace.idFromName(entry.instanceName))
      .observeCutover({ namespaceId: entry.namespaceId, objectId: entry.objectId }));
    if (!result.success || result.output.namespaceId !== entry.namespaceId || result.output.objectId !== entry.objectId
      || result.output.generation !== generation || result.output.runtimeVersion !== entry.runtimeVersion
      || result.output.sdkVersion !== (generation === 'g1' ? '0.15.0' : '0.20.1')) {
      // Distinguish RPC failure from response-shape rejection without leaking contents.
      return { ...unavailable, unknowns: ['instance observation response unacceptable'] };
    }
    return { ...result.output, limitations: [...result.output.limitations, ...unavailable.limitations] };
  } catch (error) {
    // Identity mismatch means the consulted object is not the derived one; any other
    // failure stays generic. Class names only — never exception contents.
    const kind = error instanceof Error && /identity/i.test(error.message)
      ? 'instance identity mismatch at object' : 'instance observation failed';
    // Observability aid: log the full failure for account-side tail diagnosis;
    // the response still carries only the coarse classification, never text.
    console.log(`[cutover-diag] observation failure: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    return { ...unavailable, unknowns: [kind] };
  }
}
const terminal = "status NOT IN ('completed','failed','cancelled')";
// A failed notification is an outstanding obligation unless it carries the
// approved cutover disposition marker (user-approved terminal history).
const notificationsPredicate = "status<>'sent' AND (status<>'failed' OR error<>'cutover disposition: historical notification not delivered')";
const predicates: Record<string, [string, string, string[]]> = {
  pendingMessages: ['pending_messages', "status='pending'", ['pending', 'absorbed', 'dispatched']],
  activeReceipts: ['slack_turn_activity', "status='active'", ['active', 'completed', 'failed']],
  agentRuns: ['agent_runs', terminal, ['queued', 'dispatching', 'running', 'waiting_human', 'waiting_approval', 'completed', 'failed', 'cancelled']],
  workRuns: ['work_runs', terminal, ['pending', 'running', 'completed', 'failed', 'cancelled']],
  notifications: ['agent_run_notifications', notificationsPredicate, ['pending', 'sent', 'failed']],
  replyOutbox: ['slack_reply_outbox', "status<>'sent'", ['pending', 'sending', 'uncertain', 'sent']],
  replyTrackers: ['slack_reply_trackers', "status IN ('pending','staged') OR receipt_completed_at IS NULL", ['pending', 'staged', 'delivered', 'silent', 'empty', 'failed', 'aborted']],
};
async function aggregate(db: D1Like, query: string): Promise<number> {
  return validCount((await db.prepare(query).bind().first<{ n: number }>())?.n);
}
export async function readCutoverStatus(env: DiagnosticEnv, generation: Generation, now = Date.now()) {
  const productCounts: Record<string, number> = {}, informational: Record<string, number> = {};
  const unknowns: string[] = [], blockers: string[] = [];
  let controlState: 'open' | 'closed' | 'unknown' = 'unknown';
  let revision: number | null = null, closedAt: number | null = null, producerCount: number | null = null;
  const db = env.DB;
  if (env.CUTOVER_CONTROL !== 'd1' || !db) unknowns.push('admission control unavailable');
  else {
    try {
      const row = await db.prepare('SELECT state,revision,updated_at FROM cutover_control WHERE id=1').bind()
        .first<{ state: string; revision: number; updated_at: number }>();
      if (!row || !['open', 'closed'].includes(row.state)) throw new Error('invalid control');
      revision = validCount(row.revision); validCount(row.updated_at);
      controlState = row.state as 'open' | 'closed'; closedAt = row.state === 'closed' ? row.updated_at : null;
      producerCount = await aggregate(db, 'SELECT COUNT(*) AS n FROM cutover_producers');
      if (producerCount > 0) blockers.push('producer operations outstanding');
      if (controlState === 'open') blockers.push('admissions open');
    } catch { unknowns.push('admission control unavailable'); controlState = 'unknown'; }
  }
  for (const [key, [table, predicate, known]] of Object.entries(predicates)) {
    if (generation === 'g1' && ['replyOutbox', 'replyTrackers'].includes(key)) continue;
    try {
      if (!db) throw new Error('no database');
      const count = await aggregate(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${predicate}`);
      const unexpected = await aggregate(db, `SELECT COUNT(*) AS n FROM ${table} WHERE status IS NULL OR status NOT IN (${known.map(x => `'${x}'`).join(',')})`);
      if (unexpected) unknowns.push(`unexpected product status: ${key}`);
      productCounts[key] = count;
      if (count > 0) blockers.push(`product obligation: ${key}`);
    } catch { unknowns.push(`product count unavailable: ${key}`); }
  }
  if (generation === 'g2') {
    const ingressQueries: Record<string, string> = {
      slackIngressPending: "SELECT COUNT(*) AS n FROM slack_ingress WHERE state IN ('received','preparing','ready','uncertain')",
      slackIngressFailed: "SELECT COUNT(*) AS n FROM slack_ingress WHERE state='failed' OR ack_state='rejected'",
      slackIngressAckUncertain: "SELECT COUNT(*) AS n FROM slack_ingress WHERE ack_state IN ('sending','uncertain')",
      slackIngressStorageInvalid: `SELECT COUNT(*) AS n FROM slack_ingress i LEFT JOIN slack_ingress_manifests m ON m.id=i.manifest_id
        WHERE i.failure_category='storage-invalid' OR (i.manifest_id IS NOT NULL AND (
          m.id IS NULL OR m.ingress_id<>i.id OR m.encoding_version<>1 OR m.total_bytes NOT BETWEEN 1 AND 11495904
          OR m.chunk_count NOT BETWEEN 1 AND 12 OR m.preparation_revision>=i.revision
          OR (SELECT COUNT(*) FROM slack_ingress_chunks c WHERE c.manifest_id=m.id)<>m.chunk_count
          OR (SELECT COALESCE(SUM(length(bytes)),0) FROM slack_ingress_chunks c WHERE c.manifest_id=m.id)<>m.total_bytes
          OR (SELECT MIN(ordinal) FROM slack_ingress_chunks c WHERE c.manifest_id=m.id)<>0
          OR (SELECT MAX(ordinal) FROM slack_ingress_chunks c WHERE c.manifest_id=m.id)<>m.chunk_count-1
          OR EXISTS(SELECT 1 FROM slack_ingress_chunks c WHERE c.manifest_id=m.id AND length(bytes) NOT BETWEEN 1 AND 1000000)))
          OR (i.state IN ('ready','uncertain') AND i.manifest_id IS NULL)`,
    };
    for (const [key, query] of Object.entries(ingressQueries)) {
      try { if (!db) throw new Error('no database'); productCounts[key] = await aggregate(db, query); }
      catch { unknowns.push(`product count unavailable: ${key}`); }
    }
    try {
      if (!db) throw new Error('no database');
      if (await aggregate(db, "SELECT COUNT(*) AS n FROM slack_ingress WHERE state NOT IN ('received','preparing','ready','uncertain','accepted','failed') OR ack_state NOT IN ('none','intent','sending','uncertain','posted','skipped','rejected')")) {
        unknowns.push('unexpected product status: slackIngressPending');
      }
      // A single status request verifies at most one outstanding published request.
      // More work remains unknown; no SQL count is presented as a BLOB hash certificate.
      const outstanding = await aggregate(db, "SELECT COUNT(*) AS n FROM slack_ingress WHERE state<>'accepted' AND manifest_id IS NOT NULL");
      if (outstanding > 1) unknowns.push('ingress storage integrity coverage incomplete');
      else if (outstanding === 1) {
        const row = await db.prepare("SELECT id FROM slack_ingress WHERE state<>'accepted' AND manifest_id IS NOT NULL ORDER BY id LIMIT 1").bind().first<{ id: string }>();
        if (!row) throw new Error('integrity coverage changed');
        try { await loadFrozenRequest(requireIngressDb(db), row.id); }
        catch (error) {
          if (!(error instanceof FrozenRequestInvalid)) throw error;
          productCounts.slackIngressStorageInvalid = Math.max(1, productCounts.slackIngressStorageInvalid ?? 0);
        }
        if (await aggregate(db, "SELECT COUNT(*) AS n FROM slack_ingress WHERE state<>'accepted' AND manifest_id IS NOT NULL") !== outstanding) {
          unknowns.push('ingress storage integrity coverage changed');
        }
      }
    } catch { unknowns.push('ingress storage integrity unavailable'); }
    for (const key of Object.keys(ingressQueries)) if (productCounts[key] > 0) blockers.push(`product obligation: ${key}`);
  }
  for (const [key, query] of Object.entries({ claimedParkedMessages: "SELECT COUNT(*) AS n FROM pending_messages WHERE status IN ('absorbed','dispatched')",
    unsuccessfulRuns: "SELECT COUNT(*) AS n FROM agent_runs WHERE status IN ('failed','cancelled')",
    workItemBacklog: "SELECT COUNT(*) AS n FROM work_items WHERE status NOT IN ('completed','failed','cancelled')" })) {
    try { if (!db) throw new Error('no database'); informational[key] = await aggregate(db, query); }
    catch { unknowns.push(`informational count unavailable: ${key}`); }
  }
  return { status: blockers.length ? 'blocked' : unknowns.length ? 'unknown' : 'observed-idle', generation, observedAt: now,
    controlState, revision, closedAt, producerCount, productCounts, informational, blockers, unknowns,
    limitations: ['Product counts do not establish native fleet quiescence.', 'Primary D1 reads are not an atomic native/D1 snapshot.',
      'Claimed parked rows and failed terminal effects require independent delivery disposition evidence.',
      'Storage hash coverage is limited to outstanding published requests; retained accepted payloads are not a fleet certificate.'] };
}
export async function changeCutoverAdmissions(env: DiagnosticEnv, value: unknown): Promise<{ status: number; body: unknown }> {
  const parsed = v.safeParse(v.strictObject({ state: v.picklist(['open', 'closed']), expectedRevision: v.pipe(v.number(), v.safeInteger(), v.minValue(0)) }), value);
  if (!parsed.success) return { status: 400, body: { error: 'invalid admission control request' } };
  if (env.CUTOVER_CONTROL !== 'd1' || !env.DB) return { status: 503, body: { error: 'admission control unavailable' } };
  try {
    const changed = await setAdmissionState(env.DB, parsed.output.expectedRevision, parsed.output.state);
    return { status: changed ? 200 : 409, body: { changed } };
  } catch { return { status: 503, body: { error: 'admission control unavailable' } }; }
}
