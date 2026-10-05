import { readSlackIngress, updateLeasedIngress, leaseWhere, leaseValues, type IngressDb, type IngressLease, type IngressRow } from './ingress-store';
import { postMessage, SlackApiError } from './post';
import { findPostedReply } from './reconcile-post';
import { personaIdentity, type Persona } from '../project/persona';
import { withWallClock } from '../shared/wall-clock';

export interface DurableAckInput {
  ingressId: string; token?: string; channel: string; threadTs?: string;
  oldestTs: string; text: string; persona: Persona | null; botId?: string; appId?: string;
}
export type DurableAckResult = { status: 'posted'; ts: string }
  | { status: 'retryable-rejection'; retryAfterMs: number }
  | { status: 'skipped' | 'rejected' | 'uncertain' };
const permanent = new Set(['invalid_auth','not_authed','account_inactive','token_revoked','channel_not_found',
  'not_in_channel','is_archived','missing_scope','no_permission','restricted_action','msg_too_long']);

export async function ensureIngressAck(db: IngressDb, lease: IngressLease, input: DurableAckInput, now: number,
  acceptedRow?: IngressRow): Promise<DurableAckResult> {
  if (input.ingressId !== lease.id || lease.phase !== 'prepare') throw new Error('Ack lease identity conflict');
  const started = Date.now(), clock = () => now + Math.max(0, Date.now() - started);
  const row = acceptedRow ?? await readSlackIngress(db, lease.id);
  if (row && row.id !== lease.id) throw new Error('Ack row identity conflict');
  if (!row) return { status: 'uncertain' };
  if (row.ack_state === 'posted' && row.ack_message_ts) return { status: 'posted', ts: row.ack_message_ts };
  if (row.ack_state === 'skipped') return { status: 'skipped' };
  if (row.ack_state === 'rejected') return { status: 'rejected' };
  const intent = { channel: input.channel, threadTs: input.threadTs ?? null, oldestTs: input.oldestTs,
    text: input.text, persona: input.persona, botId: input.botId ?? null, appId: input.appId ?? null,
    deliveryId: `ingress-ack:${lease.id}` };
  if (row.ack_json && row.ack_json !== JSON.stringify(intent)) throw new Error('Frozen acknowledgement conflict');
  if (row.ack_state === 'none') {
    if (!input.token) {
      return await updateLeasedIngress(db, lease, "ack_state='skipped',ack_json=?", [JSON.stringify({ reason: 'missing-token' })], clock())
        ? { status: 'skipped' } : { status: 'uncertain' };
    }
    if (!await updateLeasedIngress(db, lease, "ack_state='intent',ack_json=?", [JSON.stringify(intent)], clock())) return { status: 'uncertain' };
  }
  if (!input.token) return { status: 'uncertain' };
  if (row.ack_state === 'sending' || row.ack_state === 'uncertain') {
    let ts: string | null = null;
    try { ts = await withWallClock(findPostedReply(input.token, intent.channel, intent.deliveryId, intent.threadTs ?? undefined,
      { maxPages: 2, pageSize: 100, oldestTs: intent.oldestTs,
        ...(intent.botId ? { botId: intent.botId } : {}), ...(intent.appId ? { appId: intent.appId } : {}) }), 10_000, 'Ack metadata lookup'); } catch { /* Missing evidence is uncertainty. */ }
    if (ts && await updateLeasedIngress(db, lease, "ack_state='posted',ack_message_ts=?", [ts], clock())) return { status: 'posted', ts };
    await updateLeasedIngress(db, lease, "ack_state='uncertain'", [], clock());
    return { status: 'uncertain' };
  }
  if (!await updateLeasedIngress(db, lease, "ack_state='sending'", [], clock())) return { status: 'uncertain' };
  try {
    const ts = await withWallClock(postMessage(input.token, intent.channel, intent.text, intent.threadTs ?? undefined,
      { format: false, ...personaIdentity(intent.persona), deliveryId: intent.deliveryId }), 1000, 'Ack post');
    if (!ts || !/^\d+\.\d+$/.test(ts)) throw new Error('Ack success timestamp unavailable');
    return await updateLeasedIngress(db, lease, "ack_state='posted',ack_message_ts=?", [ts], clock())
      ? { status: 'posted', ts } : { status: 'uncertain' };
  } catch (error) {
    // Saving a successful post can commit before its response is lost. Preserve that
    // canonical confirmation; a transport catch must not erase known durable truth.
    let committed: IngressRow | null = null;
    try { committed = await readSlackIngress(db, lease.id); } catch { /* unavailable remains unknown */ }
    if (committed?.ack_state === 'posted' && committed.ack_message_ts
      && /^\d+\.\d+$/.test(committed.ack_message_ts) && committed.ack_json === JSON.stringify(intent)) {
      return { status: 'posted', ts: committed.ack_message_ts };
    }
    if (error instanceof SlackApiError && (error.httpStatus === 429 || ['ratelimited','rate_limited'].includes(error.code))) {
      if (!await updateLeasedIngress(db, lease, "ack_state='intent'", [], clock())) return { status: 'uncertain' };
      return { status: 'retryable-rejection', retryAfterMs: Math.max(0, (error.retryAfterSeconds ?? 0) * 1000) };
    }
    const rejected = error instanceof SlackApiError && permanent.has(error.code);
    const at = clock();
    await db.prepare(`UPDATE slack_ingress SET ack_state=?,updated_at=? WHERE ${leaseWhere('prepare')}
      AND ack_state IN ('sending','uncertain') RETURNING id`)
      .bind(rejected ? 'rejected' : 'uncertain', at, ...leaseValues(lease, at)).first();
    return { status: rejected ? 'rejected' : 'uncertain' };
  }
}
