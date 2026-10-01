'use agent';
// Final-text-as-reply comparison (2026-10-01). Three agents, same prompt except the delivery sentence:
//   Gb  Base : today's absorb flow. Reply tool drains parked messages before posting (burst-absorb).
//   Gj  J    : native join + reply tool, cap = messages delivered in this response + 1, finish check naming unanswered messages.
//   Gf  F    : native join, NO reply tool. The final assistant text is posted from code (observer in app.ts), see FINAL-TEXT notes.
// Lines between "ARM:<x>:start" and "ARM:<x>:end" are the arm-specific custom code counted in the report.
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import { defineTool, useAgentFinish, useAgentStart, useDelivery, useModel, usePersistentState, useResponseFinish, useTool, type AgentProps } from '@flue/runtime';

const db = () => (env as any).DB as D1Database;
async function row(conv: string, kind: string, key: string, text: string, extra = '') {
  await db().prepare('INSERT INTO gwrows(conv, kind, key, text, extra, ts) VALUES (?,?,?,?,?,?)').bind(conv, kind, key, text, extra, Date.now()).run();
}
const PLANS: Record<string, string> = { '1042': 'orchid', '2203': 'falcon', '3310': 'juniper', '4125': 'saffron', '5507': 'walnut', '6618': 'cobalt' };
const REPLY_REMINDER = '\n\n[System note — not shown to the user: to say anything you MUST call reply. Text written outside that tool is discarded and the user sees nothing.]';

// Prompt: identical for all arms except DELIVERY.
const HEAD = 'You are a Slack assistant in one thread. Messages arrive as signals; the sender is in the signal attributes. ';
const DELIVERY_TOOL = "Answer each person's question by calling reply. ";
const DELIVERY_FINAL = "Your final message (the text you write after your last tool call) is posted to the thread automatically; there is no reply tool, and text before or between tool calls is not posted. ";
const TAIL = 'Start each answer with "@<sender>: ". If several questions have arrived, one answer covering all of them is best. Never answer a question you already answered. ' +
  'Besides how you deliver answers, use only lookup_customer, and only when a question asks about a customer; call it before answering.';

function useLookup(id: string, mode: 'base' | 'other') {
  useTool(
    defineTool({
      name: 'lookup_customer',
      description: "Look up a customer's plan by customer id. Slow (about 3 seconds).",
      input: v.object({ customerId: v.string() }),
      run: async ({ data }) => {
        await row(id, 'lookup', data.customerId, '');
        await new Promise((r) => setTimeout(r, 3000));
        return `plan: ${PLANS[data.customerId] ?? 'unknown'}${mode === 'base' ? REPLY_REMINDER : ''}`;
      },
    }),
  );
}

function useCommon(id: string) {
  const d = useDelivery();
  const attrs = d.kind === 'signal' ? d.attributes ?? {} : {};
  const [ack, setAck] = usePersistentState<string | null>('ack', null);
  const [used, setUsed] = usePersistentState<string[]>('used_acks', []);
  useModel('zai/glm-5.3-flash'); // owner rule: flash only
  useAgentStart(async () => {
    await row(id, 'start', attrs.eventId ?? '', d.kind === 'signal' ? d.body : '', `sender=${attrs.sender ?? ''} ackTs=${attrs.ackTs ?? ''}`);
    if (attrs.ackTs) setAck(attrs.ackTs);
  });
  useResponseFinish(() => {
    void row(id, 'resp_end', '', '');
  });
  const counts = async () => {
    const lastEnd = (await db().prepare("SELECT MAX(seq) AS m FROM gwrows WHERE conv=? AND kind='resp_end'").bind(id).first<{ m: number | null }>())?.m ?? 0;
    const q = async (k: string) => (await db().prepare('SELECT COUNT(*) AS n FROM gwrows WHERE conv=? AND kind=? AND seq>?').bind(id, k, lastEnd).first<{ n: number }>())?.n ?? 0;
    return { delivered: await q('start'), replies: await q('reply_call') };
  };
  // Deliver text: edit the unconsumed ack if known (delivery attribute first, persisted ack for joined deliveries), else fresh.
  const deliver = async (text: string) => {
    const candidate = attrs.ackTs ?? ack;
    if (candidate && !used.includes(candidate)) {
      await db().prepare("UPDATE gwrows SET text=?, extra='edited' WHERE conv=? AND kind='ack' AND key=?").bind(text, id, candidate).run();
      setUsed((prev) => [...(prev ?? []), candidate]);
    }
    await row(id, 'post', '', text);
  };
  return { attrs, counts, deliver };
}

// ARM:BASE:start
export function Gb({ id }: AgentProps) {
  const { counts, deliver } = useCommon(id);
  useLookup(id, 'base');
  useTool(
    defineTool({
      name: 'reply',
      description: 'Send your reply to the current conversation. Call this with your final response text.',
      input: v.object({ text: v.string() }),
      run: async ({ data, toolCallId }) => {
        // Hard runaway kill at 10 reply calls per response (production has no cap).
        if ((await counts()).replies >= 10) { await row(id, 'cap_hit', toolCallId, data.text); return 'REFUSED: reply limit reached. End your turn now.'; }
        // Drain-before-post (src/slack/absorb.ts drainNoticeForReply).
        const { results } = await db().prepare("SELECT id, sender, text FROM pending WHERE conv=? AND status='pending' ORDER BY id").bind(id).all<{ id: number; sender: string; text: string }>();
        if (results?.length) {
          for (const r of results) await db().prepare("UPDATE pending SET status='absorbed' WHERE id=? AND status='pending'").bind(r.id).run();
          await row(id, 'drain', String(results.length), '');
          return `NOT SENT — ${results.length} new message(s) arrived in this conversation while you worked:\n${results.map((r) => `[${r.sender}]: ${r.text}`).join('\n')}\nRevise your reply so ONE message addresses everything (the original request and the new messages), then call reply again.`;
        }
        await row(id, 'reply_call', toolCallId, data.text);
        await deliver(data.text);
        return 'sent';
      },
    }),
  );
  return HEAD + DELIVERY_TOOL + TAIL;
}
// ARM:BASE:end

// ARM:J:start
export function Gj({ id }: AgentProps) {
  const { counts, deliver } = useCommon(id);
  useLookup(id, 'other');
  useTool(
    defineTool({
      name: 'reply',
      description: 'Send a reply into the Slack thread.',
      input: v.object({ text: v.string() }),
      run: async ({ data, toolCallId }) => {
        const c = await counts();
        if (c.replies >= c.delivered + 1) { await row(id, 'cap_hit', toolCallId, data.text); return 'REFUSED: you already sent as many replies as messages delivered plus one. End your turn now.'; }
        await row(id, 'reply_call', toolCallId, data.text);
        await deliver(data.text);
        return 'sent';
      },
    }),
  );
  useAgentFinish(async ({ append }) => {
    const c = await counts();
    if (c.replies >= c.delivered + 1) return;
    const lastReply = (await db().prepare("SELECT MAX(seq) AS m FROM gwrows WHERE conv=? AND kind='reply_call'").bind(id).first<{ m: number | null }>())?.m ?? 0;
    const { results } = await db().prepare("SELECT text, extra FROM gwrows WHERE conv=? AND kind='start' AND seq>? ORDER BY seq").bind(id, lastReply).all<{ text: string; extra: string }>();
    if (results?.length) {
      await row(id, 'finish_nudge', '', '');
      const list = results.map((r) => `- ${r.extra.match(/sender=(\w*)/)?.[1] ?? '?'}: ${r.text.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
      append({ kind: 'signal', type: 'reply.missing', body: `You have not replied to these messages yet:\n${list}\nCall reply now with one answer that covers them all.` });
    }
  });
  return HEAD + DELIVERY_TOOL + TAIL;
}
// ARM:J:end

// ARM:F:start
export function Gf({ id }: AgentProps) {
  useCommon(id);
  useLookup(id, 'other');
  // No reply tool. Flue has no hook that exposes the final assistant text, so app.ts observes `message_end`
  // (assistant messages without tool calls) into D1 and posts the last one at `submission_settled`.
  // This hook only handles an empty final message: nudge once per response, else give up ("empty final").
  useAgentFinish(async ({ append }) => {
    await new Promise((r) => setTimeout(r, 1500)); // let the observer's canonical-flush lag catch up
    const last = await db().prepare('SELECT text FROM lasttext WHERE conv=? AND posted=0').bind(id).first<{ text: string }>();
    if (last?.text?.trim()) return;
    const lastEnd = (await db().prepare("SELECT MAX(seq) AS m FROM gwrows WHERE conv=? AND kind='resp_end'").bind(id).first<{ m: number | null }>())?.m ?? 0;
    const nudged = (await db().prepare("SELECT COUNT(*) AS n FROM gwrows WHERE conv=? AND kind='f_nudge' AND seq>?").bind(id, lastEnd).first<{ n: number }>())?.n ?? 0;
    if (nudged) return; // give up; the settle handler records "empty final"
    await row(id, 'f_nudge', '', '');
    append({ kind: 'signal', type: 'final.empty', body: 'Your final message was empty. Answer the question(s) now in your final message.' });
  });
  return HEAD + DELIVERY_FINAL + TAIL;
}
// ARM:F:end
