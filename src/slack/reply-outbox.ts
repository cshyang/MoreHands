import type { D1Like } from '../skills/repository';
import type { ConversationTarget } from '../project/conversations';
import { personaIdentity, type Persona } from '../project/persona';
import { chunkSlackText, formatSlackText, SLACK_TEXT_LIMIT } from './format';
import { editMessage, postMessage, SlackApiError } from './post';
import { findPostedReply } from './reconcile-post';
import { settleSlackTurnActivity } from './activity';
import { reserveIngressBudget, reserveIngressBudgetShare, remainingIngressBudget } from './ingress-budget';

export interface ReplyPart {
  delivery_id: string;
  instance_id: string;
  response_id: string;
  project_id: string;
  conversation_id: string;
  target_json: string;
  persona_json: string | null;
  part_index: number;
  text: string;
  edit_ts: string | null;
  posted_ts: string | null;
  status: 'pending' | 'sending' | 'uncertain' | 'sent';
  lease_until: number;
}

export async function stageReply(db: D1Like, input: {
  instanceId: string; responseId: string; target: ConversationTarget; text: string;
  persona?: Persona | null; editTs?: string; maxChars?: number; now?: number;
}): Promise<void> {
  if (!input.text.trim()) return;
  const now = input.now ?? Date.now();
  const parts = chunkSlackText(formatSlackText(input.text), { maxChars: input.maxChars ?? SLACK_TEXT_LIMIT, label: true });
  // One statement: a crash cannot leave a partially staged multi-part answer.
  await db.prepare(`INSERT INTO slack_reply_outbox
    (delivery_id,instance_id,response_id,project_id,conversation_id,target_json,persona_json,part_index,text,edit_ts,created_at,updated_at)
    SELECT ? || ':' || ? || ':' || key, ?, ?, ?, ?, ?, ?, key, value,
      CASE WHEN key=0 THEN ? ELSE NULL END, ?, ? FROM json_each(?) WHERE true
    ON CONFLICT(delivery_id) DO NOTHING`).bind(
      input.instanceId, input.responseId, input.instanceId, input.responseId,
      input.target.projectId, input.target.conversationId, JSON.stringify(input.target),
      input.persona ? JSON.stringify(input.persona) : null, input.editTs ?? null,
      now, now, JSON.stringify(parts),
    ).run();
}

export interface ReplyTransport {
  edit: typeof editMessage;
  post: typeof postMessage;
  find: typeof findPostedReply;
}
const transport: ReplyTransport = { edit: editMessage, post: postMessage, find: findPostedReply };
const LEASE_MS = 60_000;

/** Claim before the network call. An expired new-post claim becomes uncertain, never pending.
 *  chat.update can safely repeat; chat.postMessage requires a positive history match. */
export async function deliverReplyPart(inputDb: D1Like, env: Record<string, unknown>, id: string, options: {
  now?: number; transport?: ReplyTransport;
} = {}): Promise<'sent' | 'waiting' | 'uncertain'> {
  const operation = reserveIngressBudget(inputDb, 6); // row/previous/root/claim/save + failed-save fallback
  if (!operation) return 'waiting';
  const db = operation.db;
  try {
    const now = options.now ?? Date.now();
    const wire = options.transport ?? transport;
    const row = await db.prepare(`SELECT * FROM slack_reply_outbox WHERE delivery_id=?`).bind(id).first<ReplyPart>();
    if (!row || row.status === 'sent') return 'sent';
    if (row.status === 'sending' && row.lease_until > now) return 'waiting';
    const target = JSON.parse(row.target_json) as ConversationTarget;
    const token = env[target.transportTokenRef];
    if (typeof token !== 'string' || !token) throw new Error(`Missing transport token env "${target.transportTokenRef}".`);
    // Preserve chunk order. Top-level replies use part zero's ts as their thread root.
    const previous = row.part_index > 0
      ? await db.prepare(`SELECT posted_ts,status FROM slack_reply_outbox WHERE instance_id=? AND response_id=? AND part_index=?`)
        .bind(row.instance_id, row.response_id, row.part_index - 1).first<{ posted_ts: string | null; status: string }>()
      : null;
    if (row.part_index > 0 && previous?.status !== 'sent') {
      // Rotate blocked chunks too; otherwise a long uncertain answer owns every sweep.
      await db.prepare(`UPDATE slack_reply_outbox SET updated_at=?
        WHERE delivery_id=? AND status=? AND lease_until=?`).bind(now, id, row.status, row.lease_until).run();
      return 'waiting';
    }
    const root = !target.externalConversationId && row.part_index > 0
      ? await db.prepare(`SELECT posted_ts FROM slack_reply_outbox WHERE instance_id=? AND response_id=? AND part_index=0`)
        .bind(row.instance_id, row.response_id).first<{ posted_ts: string | null }>()
      : null;
    const threadTs = target.externalConversationId ?? root?.posted_ts ?? undefined;
    const uncertain = !row.edit_ts && (row.status === 'uncertain' || row.status === 'sending');
    const claimed = await db.prepare(`UPDATE slack_reply_outbox SET status='sending',lease_until=?,updated_at=?
      WHERE delivery_id=? AND status=? AND lease_until=? RETURNING delivery_id`)
      .bind(now + LEASE_MS, now, id, row.status, row.lease_until).first<{ delivery_id: string }>();
    if (!claimed) return 'waiting';
    const finish = async (ts: string) => {
      await db.prepare(`UPDATE slack_reply_outbox SET status='sent',posted_ts=?,lease_until=0,last_error=NULL,updated_at=?
        WHERE delivery_id=? AND status='sending' AND lease_until=?`).bind(ts, now, id, now + LEASE_MS).run();
    };
    try {
      if (uncertain) {
        const found = await wire.find(token, target.externalSpaceId, id, threadTs);
        if (found) { await finish(found); return 'sent'; }
        await db.prepare(`UPDATE slack_reply_outbox SET status='uncertain',lease_until=0,last_error=?,updated_at=?
          WHERE delivery_id=? AND lease_until=?`).bind('Post outcome unknown; no positive Slack metadata match', now, id, now + LEASE_MS).run();
        return 'uncertain';
      }
      let ts = row.edit_ts;
      if (ts) await wire.edit(token, target.externalSpaceId, ts, row.text, { format: false });
      else ts = await wire.post(token, target.externalSpaceId, row.text, threadTs, {
        format: false, ...personaIdentity(row.persona_json ? JSON.parse(row.persona_json) as Persona : null), deliveryId: id,
      }) ?? null;
      if (!ts) throw new Error('Slack accepted a post without returning its message timestamp');
      await finish(ts);
      return 'sent';
    } catch (error) {
      // A parsed Slack rejection proves no message was accepted. Transport/JSON/5xx failures do not.
      const status = row.edit_ts || (!uncertain && error instanceof SlackApiError) ? 'pending' : 'uncertain';
      await db.prepare(`UPDATE slack_reply_outbox SET status=?,lease_until=0,last_error=?,updated_at=?
        WHERE delivery_id=? AND lease_until=?`)
        .bind(status, error instanceof Error ? error.message : 'Delivery failed', now, id, now + LEASE_MS).run();
      if (status === 'pending') throw error;
      return 'uncertain';
    }
  } finally { operation.release(); }
}

/** Repair product transcript/receipt state after delivery, including a crash after Slack accepted it. */
export async function finalizeDeliveredReplies(inputDb: D1Like, env: Record<string, unknown>, instanceId?: string): Promise<void> {
  const phase = reserveIngressBudgetShare(inputDb, 1, 2);
  if (!phase) return;
  const db = phase.db;
  try {
    const scope = instanceId ? ' AND instance_id=?' : '';
    const bindings = instanceId ? [instanceId] : [];
    await db.prepare(`INSERT INTO messages(project_id,conversation_id,sender_id,role,text,created_at,delivery_id)
      SELECT project_id,conversation_id,'agent','agent',text,created_at,delivery_id
      FROM slack_reply_outbox WHERE status='sent'${scope}
      ON CONFLICT(delivery_id) DO NOTHING`).bind(...bindings).run();
    const { results } = await db.prepare(`SELECT instance_id,event_id,target_json,ack_message_ts,status FROM slack_reply_trackers t
      WHERE receipt_completed_at IS NULL AND (
        status IN ('silent','empty','failed','aborted') OR (status='staged'
          AND EXISTS (SELECT 1 FROM slack_reply_outbox o WHERE o.instance_id=t.instance_id AND o.response_id=t.response_id)
          AND NOT EXISTS (SELECT 1 FROM slack_reply_outbox o
            WHERE o.instance_id=t.instance_id AND o.response_id=t.response_id AND o.status!='sent'))
      )${scope} ORDER BY updated_at,created_at LIMIT 50`).bind(...bindings)
      .all<{ instance_id: string; event_id: string; target_json: string; ack_message_ts: string | null; status: string }>();
    let firstError: unknown;
    for (const row of results) {
      const operation = reserveIngressBudget(db, 5); // activity reads/CAS, tracker completion, failed chrome rotation
      if (!operation) break;
      const recordDb = operation.db;
      try {
        const target = JSON.parse(row.target_json) as ConversationTarget;
        await settleSlackTurnActivity(recordDb, env, { projectId: target.projectId, conversationId: target.conversationId,
          ackMessageTs: row.ack_message_ts ?? undefined,
          outcome: row.status === 'staged' || row.status === 'silent' ? 'completed'
            : row.status === 'aborted' ? 'aborted' : 'failed' });
        await recordDb.prepare(`UPDATE slack_reply_trackers SET status=?,receipt_completed_at=?,updated_at=?
          WHERE instance_id=? AND event_id=? AND status=? AND receipt_completed_at IS NULL`)
          .bind(row.status === 'staged' ? 'delivered' : row.status, Date.now(), Date.now(), row.instance_id, row.event_id, row.status).run();
      } catch (error) {
        firstError ??= error;
        // Rotate failed chrome repairs without suppressing other conversations' completion.
        await recordDb.prepare(`UPDATE slack_reply_trackers SET updated_at=? WHERE instance_id=? AND event_id=?
          AND receipt_completed_at IS NULL`).bind(Date.now(), row.instance_id, row.event_id).run();
      } finally { operation.release(); }
    }
    if (firstError) throw firstError;
  } finally { phase.release(); }
}

export async function deliverPendingReplies(inputDb: D1Like, env: Record<string, unknown>, instanceId?: string): Promise<void> {
  const phase = reserveIngressBudgetShare(inputDb, 1);
  if (!phase) return;
  const db = phase.db;
  try {
    const { results } = await db.prepare(`SELECT delivery_id FROM slack_reply_outbox
      WHERE status!='sent' AND lease_until<=?${instanceId ? ' AND instance_id=?' : ''}
      ORDER BY updated_at,created_at,part_index LIMIT 50`).bind(Date.now(), ...(instanceId ? [instanceId] : [])).all<{ delivery_id: string }>();
    for (const row of results) {
      if (remainingIngressBudget(db) < 6) break;
      await deliverReplyPart(db, env, row.delivery_id).catch((error) =>
        console.log(`[reply] delivery failed: ${error instanceof Error ? error.message : 'error'}`),
      );
    }
  } finally { phase.release(); }
}
