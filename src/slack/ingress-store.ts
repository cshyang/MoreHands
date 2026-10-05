import type { D1Like } from '../skills/repository';
import type { Binding } from '../project/bindings';
import type { ConversationTarget } from '../project/conversations';
import type { Persona } from '../project/persona';
import type { DispatchReceipt } from '@flue/runtime';

export type BoundD1Statement = ReturnType<ReturnType<D1Like['prepare']>['bind']>;
export interface IngressDb extends D1Like {
  batch(statements: BoundD1Statement[]): Promise<Array<{ success: boolean; meta?: { changes?: number }; results?: unknown[] }>>;
}
export type IngressState = 'received' | 'preparing' | 'ready' | 'uncertain' | 'accepted' | 'failed';
export type IngressMode = 'quiet' | 'engaged' | 'overhear';
export interface VerifiedIngressEvent { key: string; teamId: string; eventId: string; digest: string; eventJson: string }
export type IngressAcceptance = { status: 'accepted'; id: string; duplicate: boolean } | { status: 'closed' } | { status: 'conflict' };
export interface IngressLease { id: string; owner: string; revision: number; expiresAt: number; phase: 'prepare' | 'handoff' }
export interface FrozenIngressRoute {
  mode: IngressMode; deliveryEventId: string; epoch: number; instanceId: string | null;
  target: ConversationTarget | null; binding: Binding | null; persona: Persona | null;
  skipAck: boolean; overhearNow?: string; bindingSource?: 'seed' | 'database';
}
export interface IngressRow {
  id: string; team_id: string; event_id: string; digest: string; event_json: string;
  state: IngressState; revision: number; lease_owner: string | null; lease_expires_at: number | null;
  target_json: string | null; manifest_id: string | null; receipt_json: string | null;
  mode: IngressMode | null; instance_id: string | null; tracker_event_id: string | null;
  effects_complete: 0 | 1; next_attempt_at: number; prepare_attempts: number; handoff_attempts: number;
  file_effects_json: string | null; file_effect_cursor: number;
  failure_category: string | null; content_retention: 'retained' | 'tombstoned';
  ack_state: 'none' | 'intent' | 'sending' | 'posted' | 'skipped' | 'rejected' | 'uncertain';
  ack_json: string | null; ack_message_ts: string | null;
}
export const INGRESS_ATTEMPT_LIMIT = 8;
export const INGRESS_EVENT_MAX_BYTES = 1_000_000;
export class IngressUnavailable extends Error { constructor() { super('Slack ingress unavailable'); } }
export class IngressConflict extends Error { constructor() { super('Slack ingress identity conflict'); } }

export function requireIngressDb(value: unknown): IngressDb {
  if (!value || typeof value !== 'object' || typeof (value as IngressDb).prepare !== 'function'
    || typeof (value as IngressDb).batch !== 'function') throw new IngressUnavailable();
  return value as IngressDb;
}
export async function acceptSlackIngress(db: IngressDb, event: VerifiedIngressEvent,
  options: { now?: number; id?: string } = {}): Promise<IngressAcceptance> {
  if (!event.teamId || !event.eventId || event.key !== `${event.teamId}:${event.eventId}`
    || /[\s\u0000-\u001f\u007f]/.test(event.key) || `slack:${event.key}`.length > 256
    || !/^[a-f0-9]{64}$/.test(event.digest) || new TextEncoder().encode(event.eventJson).length > INGRESS_EVENT_MAX_BYTES) {
    throw new IngressConflict();
  }
  const parsed = JSON.parse(event.eventJson) as { team_id?: unknown; event_id?: unknown };
  if (parsed.team_id !== event.teamId || parsed.event_id !== event.eventId) throw new IngressConflict();
  const id = options.id ?? crypto.randomUUID(), now = options.now ?? Date.now();
  const result = await db.batch([
    db.prepare(`INSERT INTO slack_ingress(id,team_id,event_id,digest,event_json,created_at,updated_at)
      SELECT ?,?,?,?,?,?,? FROM cutover_control WHERE id=1 AND state='open' AND revision>=0 AND updated_at>=0
      ON CONFLICT(team_id,event_id) DO NOTHING RETURNING id`).bind(id, event.teamId, event.eventId, event.digest, event.eventJson, now, now),
    db.prepare('SELECT state,revision,updated_at FROM cutover_control WHERE id=1').bind(),
    db.prepare(`SELECT i.*,p.source AS producer_source,p.generation AS producer_generation,p.kind AS producer_kind
      FROM slack_ingress i LEFT JOIN cutover_producers p ON p.id=i.id WHERE i.team_id=? AND i.event_id=?`)
      .bind(event.teamId, event.eventId),
  ]);
  if (result.some(r => !r.success)) throw new IngressUnavailable();
  const control = result[1].results?.[0] as { state: string; revision: number; updated_at: number } | undefined;
  if (!control || !['open','closed'].includes(control.state) || !Number.isSafeInteger(control.revision) || control.revision < 0
    || !Number.isSafeInteger(control.updated_at) || control.updated_at < 0) throw new IngressUnavailable();
  const row = result[2].results?.[0] as (IngressRow & { producer_source: string | null; producer_generation: string | null; producer_kind: string | null }) | undefined;
  if (!row) { if (control.state === 'closed') return { status: 'closed' }; throw new IngressUnavailable(); }
  if (row.digest !== event.digest) return { status: 'conflict' };
  if (row.state === 'accepted') {
    if (row.producer_source !== null || !row.effects_complete || !row.target_json
      || (row.mode === 'quiet' ? row.content_retention !== 'tombstoned' || row.receipt_json !== null : !validReceiptJson(row.receipt_json))) {
      throw new IngressUnavailable();
    }
  } else if (row.producer_source !== 'slack' || row.producer_generation !== 'g2' || row.producer_kind !== 'intake') {
    throw new IngressUnavailable();
  }
  return { status: 'accepted', id: row.id, duplicate: result[0].results?.length !== 1 };
}
export function readSlackIngress(db: IngressDb, id: string): Promise<IngressRow | null> {
  return db.prepare('SELECT * FROM slack_ingress WHERE id=?').bind(id).first<IngressRow>();
}
export async function claimSlackIngress(db: IngressDb, id: string,
  options: { now: number; owner: string; leaseMs: number; phase: IngressLease['phase'] }): Promise<IngressLease | null> {
  const row = await readSlackIngress(db, id);
  if (!row || !options.owner || options.leaseMs <= 0) return null;
  const phase = options.phase, counter = phase === 'prepare' ? 'prepare_attempts' : 'handoff_attempts';
  const state = phase === 'prepare' ? "state IN ('received','preparing')" : "state IN ('ready','uncertain')";
  const claimed = await db.prepare(`UPDATE slack_ingress SET ${phase === 'prepare' ? "state='preparing'," : ''}
    revision=revision+1,${counter}=${counter}+1,lease_owner=?,lease_expires_at=?,updated_at=?
    WHERE id=? AND revision=? AND ${state} AND ${counter}<? AND next_attempt_at<=?
      AND (lease_owner IS NULL OR lease_expires_at<=?) RETURNING revision,lease_expires_at`)
    .bind(options.owner, options.now + options.leaseMs, options.now, id, row.revision, INGRESS_ATTEMPT_LIMIT, options.now, options.now)
    .first<{ revision: number; lease_expires_at: number }>();
  return claimed ? { id, owner: options.owner, revision: claimed.revision, expiresAt: claimed.lease_expires_at, phase } : null;
}
export function leaseWhere(phase: IngressLease['phase']): string {
  return `id=? AND lease_owner=? AND revision=? AND lease_expires_at>? AND ${phase === 'prepare' ? "state='preparing'" : "state IN ('ready','uncertain')"}`;
}
export function leaseValues(lease: IngressLease, now: number): unknown[] { return [lease.id, lease.owner, lease.revision, now]; }
export async function updateLeasedIngress(db: IngressDb, lease: IngressLease, set: string, values: unknown[], now: number): Promise<boolean> {
  const row = await db.prepare(`UPDATE slack_ingress SET ${set},updated_at=? WHERE ${leaseWhere(lease.phase)} RETURNING id`)
    .bind(...values, now, ...leaseValues(lease, now)).first<{ id: string }>();
  return !!row;
}
export async function renewSlackIngressLease(db: IngressDb, lease: IngressLease, now: number, leaseMs: number): Promise<IngressLease | null> {
  return await updateLeasedIngress(db, lease, 'lease_expires_at=?', [now + leaseMs], now) ? { ...lease, expiresAt: now + leaseMs } : null;
}
export function ingressBackoff(attempts: number): number { return Math.min(120_000 * 2 ** Math.max(0, attempts - 1), 3_600_000); }
export async function deferSlackIngress(db: IngressDb, lease: IngressLease, category: string, now: number, nextAttemptAt: number): Promise<boolean> {
  if (!/^[a-z0-9-]{1,80}$/.test(category)) throw new IngressConflict();
  const counter = lease.phase === 'prepare' ? 'prepare_attempts' : 'handoff_attempts';
  return updateLeasedIngress(db, lease,
    `${lease.phase === 'handoff' && category === 'native-uncertain' ? "state='uncertain'," : ''}
      revision=revision+1,lease_owner=NULL,lease_expires_at=NULL,
      failure_category=CASE WHEN ${counter}>=${INGRESS_ATTEMPT_LIMIT} THEN 'retry-exhausted:' || ? ELSE ? END,next_attempt_at=?`,
    [category, category, nextAttemptAt], now);
}
export async function failSlackIngress(db: IngressDb, lease: IngressLease, category: string, now: number): Promise<boolean> {
  return updateLeasedIngress(db, lease, "state='failed',revision=revision+1,lease_owner=NULL,lease_expires_at=NULL,failure_category=?", [category], now);
}
export async function listRecoverableSlackIngress(db: IngressDb, now: number, limit: number): Promise<string[]> {
  const { results } = await db.prepare(`SELECT id FROM slack_ingress WHERE next_attempt_at<=?
    AND (lease_owner IS NULL OR lease_expires_at<=?)
    AND ((state IN ('received','preparing') AND prepare_attempts<?) OR (state IN ('ready','uncertain') AND handoff_attempts<?))
    ORDER BY next_attempt_at,created_at,id LIMIT ?`).bind(now, now, INGRESS_ATTEMPT_LIMIT, INGRESS_ATTEMPT_LIMIT,
      Math.min(8, Math.max(1, limit))).all<{ id: string }>();
  return results.map(r => r.id);
}
function validReceiptJson(value: string | null): boolean {
  if (!value) return false;
  try { return !!normalizeReceipt(JSON.parse(value) as DispatchReceipt); } catch { return false; }
}
export function normalizeReceipt(receipt: DispatchReceipt): { submissionId: string; uid: string; acceptedAt: string } {
  if (!receipt || typeof receipt.submissionId !== 'string' || !receipt.submissionId.trim()
    || typeof receipt.uid !== 'string' || !receipt.uid.trim() || typeof receipt.acceptedAt !== 'string' || !Number.isFinite(Date.parse(receipt.acceptedAt))) {
    throw new IngressConflict();
  }
  return { submissionId: receipt.submissionId, uid: receipt.uid, acceptedAt: receipt.acceptedAt };
}
export async function completeSlackIngress(db: IngressDb, lease: IngressLease, receipt: DispatchReceipt | null, now: number): Promise<boolean> {
  const row = await readSlackIngress(db, lease.id);
  if (!row || !row.target_json) return false;
  const route = JSON.parse(row.target_json) as FrozenIngressRoute;
  const canonical = receipt ? JSON.stringify(normalizeReceipt(receipt)) : null;
  if (row.state === 'accepted') return row.receipt_json === canonical;
  if (route.mode === 'quiet' ? receipt !== null || lease.phase !== 'prepare' : receipt === null || lease.phase !== 'handoff') throw new IngressConflict();
  const batch: BoundD1Statement[] = [];
  if (route.mode === 'engaged' && receipt) {
    batch.push(db.prepare(`UPDATE slack_reply_trackers SET submission_id=?,uid=COALESCE(uid,?),updated_at=?
      WHERE instance_id=? AND event_id=? AND (submission_id IS NULL OR submission_id=?) AND (uid IS NULL OR uid=?)
        AND EXISTS(SELECT 1 FROM slack_ingress WHERE ${leaseWhere(lease.phase)})`)
      .bind(receipt.submissionId, receipt.uid, now, row.instance_id, row.tracker_event_id, receipt.submissionId, receipt.uid, ...leaseValues(lease, now)));
  }
  batch.push(db.prepare(`UPDATE slack_ingress SET state='accepted',receipt_json=?,revision=revision+1,
    lease_owner=NULL,lease_expires_at=NULL,failure_category=NULL,
    ${route.mode === 'quiet' ? "event_json='{}',content_retention='tombstoned',file_effects_json=NULL,file_effect_cursor=0," : ''}updated_at=?
    WHERE ${leaseWhere(lease.phase)}`).bind(canonical, now, ...leaseValues(lease, now)));
  batch.push(db.prepare('SELECT state,receipt_json FROM slack_ingress WHERE id=?').bind(lease.id));
  const result = await db.batch(batch);
  if (result.some(r => !r.success)) throw new IngressUnavailable();
  const after = result.at(-1)?.results?.[0] as { state: string; receipt_json: string | null } | undefined;
  return after?.state === 'accepted' && after.receipt_json === canonical;
}
