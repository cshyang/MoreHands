import type { D1Like } from '../skills/repository';
import type { ConversationTarget } from '../project/conversations';
import type { Persona } from '../project/persona';
import type { ConversationRecord } from '@flue/runtime/adapter';
import type { SqliteConversationStreamStore } from '@flue/runtime/internal';
import { stageReply } from './reply-outbox';

export interface ReplyAdmission {
  eventId: string;
  submissionId: string;
  /** Native settled an unready row without an attempt or canonical settlement. */
  unreadyTerminal: boolean;
}
export interface ReplyHistory {
  admissions?(instanceId: string): Promise<ReplyAdmission[]>;
  getMeta(path: string): Promise<{ incarnation: string } | null>;
  read(path: string, options?: { offset?: string; limit?: number }): Promise<{
    batches: Array<{ offset: string; records: ConversationRecord[] }>;
    nextOffset: string;
    upToDate: boolean;
  }>;
}
interface Tracker {
  event_id: string; submission_id: string | null; target_json: string; persona_json: string | null;
  ack_message_ts: string | null; publish: number; status: string; created_at: number;
}
export interface ReplySettlement {
  submissionId: string;
  responseId: string;
  outcome: 'completed' | 'failed' | 'aborted';
  status: 'staged' | 'silent' | 'empty' | 'failed' | 'aborted';
  target: ConversationTarget;
  ackMessageTs?: string;
}

/** Admit trusted delivery intent before dispatch; retries cannot change its destination. */
export async function seedReplyTracker(db: D1Like, input: {
  instanceId: string; eventId: string; target: ConversationTarget; persona?: Persona | null;
  ackMessageTs?: string; publish: boolean; now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  await db.prepare(`INSERT INTO slack_reply_trackers
    (instance_id,event_id,target_json,persona_json,ack_message_ts,publish,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(instance_id,event_id) DO NOTHING`).bind(
      input.instanceId, input.eventId, JSON.stringify(input.target), input.persona ? JSON.stringify(input.persona) : null,
      input.ackMessageTs ?? null, input.publish ? 1 : 0, now, now,
    ).run();
}
export async function attachReplySubmission(db: D1Like, input: {
  instanceId: string; eventId: string; submissionId: string; uid?: string; now?: number;
}): Promise<void> {
  await db.prepare(`UPDATE slack_reply_trackers SET submission_id=?,uid=COALESCE(uid,?),updated_at=?
    WHERE instance_id=? AND event_id=? AND (submission_id IS NULL OR submission_id=?)`).bind(
      input.submissionId, input.uid ?? null, input.now ?? Date.now(), input.instanceId, input.eventId, input.submissionId,
    ).run();
}

/** Only this adapter depends on Flue's pinned 2.2.2 internal canonical-store API.
 * Public history folds tool narration and final text together, losing the F2 boundary. */
export async function nativeReplyHistory(storage: {
  sql: ConstructorParameters<typeof SqliteConversationStreamStore>[0];
  transactionSync<T>(fn: () => T): T;
}): Promise<ReplyHistory> {
  const { SqliteConversationStreamStore } = await import('@flue/runtime/internal');
  const store = new SqliteConversationStreamStore(storage.sql, (fn) => storage.transactionSync(fn));
  return {
    getMeta: (path) => store.getMeta(path),
    read: (path, options) => store.read(path, options),
    admissions: async (instanceId) => {
      // Admission precedes canonical input. A lost dispatch receipt can still be healed
      // when an operator aborts before execution or native materialization fails.
      const rows = storage.sql.exec(`SELECT submission_id,payload,status,attempt_id,canonical_ready_at
        FROM flue_agent_submissions WHERE kind='dispatch' ORDER BY sequence`).toArray();
      return rows.flatMap((row) => {
        const input = JSON.parse(String(row.payload)) as {
          agent?: string; id?: string; submissionId?: string;
          message?: { kind?: string; attributes?: Record<string, string> };
        };
        const eventId = input.message?.attributes?.eventId;
        if (input.agent !== 'project' || input.id !== instanceId || input.submissionId !== row.submission_id
          || input.message?.kind !== 'signal' || typeof eventId !== 'string') return [];
        return [{ eventId, submissionId: String(row.submission_id),
          unreadyTerminal: row.status === 'settled' && row.attempt_id == null && row.canonical_ready_at == null }];
      });
    },
  };
}

interface Step {
  messageId: string; submissionId: string; attemptId?: string; publish: boolean; complete: boolean; invalid: boolean;
  blocks: Map<string, { index: number; deltas: Map<number, string> }>;
}

/** Replay native truth rather than persisting another transcript. Full replay also heals a
 * receipt attachment missed after dispatch. Outbox staging is idempotent; mark staged AFTER it. */
export async function reconcileReplyHistory(db: D1Like, instanceId: string, history: ReplyHistory): Promise<ReplySettlement[]> {
  const { agentStreamPath } = await import('@flue/runtime/internal');
  const path = agentStreamPath('project', instanceId);
  const trackers = (await db.prepare(`SELECT event_id,submission_id,target_json,persona_json,ack_message_ts,publish,status,created_at
    FROM slack_reply_trackers WHERE instance_id=? ORDER BY created_at,event_id`).bind(instanceId).all<Tracker>()).results ?? [];
  if (!trackers.length) return [];
  const byEvent = new Map(trackers.map((t) => [t.event_id, t]));
  for (const admission of await history.admissions?.(instanceId) ?? []) {
    const tracker = byEvent.get(admission.eventId);
    if (!tracker) continue;
    if (tracker.submission_id && tracker.submission_id !== admission.submissionId) {
      throw new Error('Reply tracker submission conflicts with durable admission');
    }
    if (!tracker.submission_id) {
      await attachReplySubmission(db, { instanceId, eventId: tracker.event_id, submissionId: admission.submissionId });
      tracker.submission_id = admission.submissionId;
    }
    if (admission.unreadyTerminal && tracker.status === 'pending') {
      // This pinned native store does not retain an outcome for unclaimable rows.
      // Close visibly as failed; never invent an answer or claim a precise abort cause.
      await db.prepare(`UPDATE slack_reply_trackers SET status='failed',outcome='failed',updated_at=?
        WHERE instance_id=? AND event_id=? AND status='pending'`).bind(Date.now(), instanceId, tracker.event_id).run();
      tracker.status = 'failed';
    }
  }
  const meta = await history.getMeta(path);
  if (!meta) return [];
  const bySubmission = new Map(trackers.filter((t) => t.submission_id).map((t) => [t.submission_id!, t]));
  const records: ConversationRecord[] = [];
  const ids = new Set<string>();
  let offset = '-1';
  for (;;) {
    const page = await history.read(path, { offset, limit: 1000 });
    for (const batch of page.batches) for (const record of batch.records) {
      if (!ids.has(record.id)) { ids.add(record.id); records.push(record); }
    }
    if (page.upToDate) break;
    if (page.nextOffset === offset) throw new Error('Flue history read made no progress');
    offset = page.nextOffset;
  }
  const root = records.find((r) => r.type === 'conversation_created' && r.kind === 'root')?.conversationId
    ?? records.find((r) => r.harness === 'default' && r.session === 'default')?.conversationId;
  const steps = new Map<string, Step>();
  const hosts = new Map<string, string>();
  const settlements: Array<Extract<ConversationRecord, { type: 'submission_settled' }>> = [];
  let currentPublish = false;
  for (const record of records) {
    if (record.conversationId !== root) continue;
    // Only real admitted inputs move the delivery cursor; framework/hook signals carry
    // the host submission stamp too, but must not restore an older publish mode.
    if (record.type === 'signal' && record.submissionId && record.id === `record_dispatch_input_${record.submissionId}`) {
      const tracker = record.attributes?.eventId ? byEvent.get(record.attributes.eventId) : bySubmission.get(record.submissionId);
      if (tracker) {
        if (tracker.submission_id && tracker.submission_id !== record.submissionId) throw new Error('Reply tracker submission conflicts with durable input');
        if (!tracker.submission_id) {
          await attachReplySubmission(db, { instanceId, eventId: tracker.event_id, submissionId: record.submissionId });
          tracker.submission_id = record.submissionId;
          bySubmission.set(record.submissionId, tracker);
        }
        currentPublish = tracker.publish === 1;
      } else currentPublish = false;
      // A step straddling a quiet admission is ambiguous; suppress it rather than
      // publishing a prefix that may contain internal output after that admission.
      if (!currentPublish) for (const step of steps.values()) if (!step.complete) step.publish = false;
    }
    if (record.type === 'assistant_message_started' && record.submissionId) {
      steps.set(record.messageId, { messageId: record.messageId, submissionId: record.submissionId,
        attemptId: record.attemptId, publish: currentPublish, complete: false, invalid: false, blocks: new Map() });
      if (record.attemptId) hosts.set(record.attemptId, record.submissionId);
    }
    if ('messageId' in record && typeof record.messageId === 'string') {
      const step = steps.get(record.messageId);
      if (step) {
        if (record.type === 'assistant_text_started') step.blocks.set(record.blockId, { index: record.blockIndex, deltas: new Map() });
        if (record.type === 'assistant_text_delta') {
          const block = step.blocks.get(record.blockId);
          if (!block) throw new Error('Flue text delta has no started block');
          block.deltas.set(record.sequence, record.delta);
        }
        if (record.type === 'assistant_tool_call') step.invalid = true;
        if (record.type === 'assistant_message_completed') {
          step.complete = true;
          step.invalid ||= !!record.error || record.stopReason === 'error' || record.stopReason === 'aborted';
        }
      }
    }
    if (record.type === 'submission_settled') settlements.push(record);
  }
  const hostSettlements = new Map(settlements.map((s) => [s.submissionId, s]));
  const results: ReplySettlement[] = [];
  for (const settlement of settlements) {
    const tracker = bySubmission.get(settlement.submissionId);
    if (!tracker || tracker.status === 'delivered') continue;
    const host = settlement.attemptId ? hosts.get(settlement.attemptId) ?? settlement.submissionId : settlement.submissionId;
    const hostSettlement = hostSettlements.get(host);
    if (!hostSettlement) continue;
    const responseId = `${meta.incarnation}:${host}`;
    const members = trackers.filter((t) => t.submission_id && settlements.some((s) => s.submissionId === t.submission_id &&
      (s.attemptId ? hosts.get(s.attemptId) ?? s.submissionId : s.submissionId) === host));
    const destination = members.find((t) => t.publish === 1 && t.ack_message_ts) ?? members.find((t) => t.publish === 1) ?? tracker;
    const target = JSON.parse(destination.target_json) as ConversationTarget;
    const destinationKey = (t: ConversationTarget) => JSON.stringify([
      t.projectId, t.agentSlug, t.conversationId, t.provider, t.externalAccountId,
      t.externalSpaceId, t.externalConversationId, t.transportTokenRef,
    ]);
    if (members.some((t) => t.publish === 1 && destinationKey(JSON.parse(t.target_json) as ConversationTarget) !== destinationKey(target))) {
      throw new Error('Joined reply has different conversation targets');
    }
    // Native recovery continues the durable conversation; earlier completed steps are
    // response checkpoints, not regenerated duplicates. Attempt IDs fence writes only.
    const text = [...steps.values()].filter((s) => s.submissionId === host && s.publish && s.complete && !s.invalid)
      .map((s) => [...s.blocks.values()].sort((a, b) => a.index - b.index)
        .map((b) => [...b.deltas.entries()].sort(([a], [b]) => a - b).map(([, delta]) => delta).join('')).join('\n').trim())
      .filter(Boolean).join('\n\n');
    const status = hostSettlement.outcome !== 'completed' ? hostSettlement.outcome
      : !members.some((t) => t.publish === 1) ? 'silent' : !text ? 'empty' : 'staged';
    if (status === 'staged') await stageReply(db, { instanceId, responseId, target, text,
      persona: destination.persona_json ? JSON.parse(destination.persona_json) as Persona : null });
    await db.prepare(`UPDATE slack_reply_trackers SET response_id=?,outcome=?,status=?,updated_at=?
      WHERE instance_id=? AND event_id=? AND status!='delivered'`).bind(responseId, hostSettlement.outcome, status, Date.now(), instanceId, tracker.event_id).run();
    results.push({ submissionId: settlement.submissionId, responseId, outcome: hostSettlement.outcome, status,
      target: JSON.parse(tracker.target_json) as ConversationTarget,
      ...(tracker.ack_message_ts ? { ackMessageTs: tracker.ack_message_ts } : {}) });
  }
  return results;
}
