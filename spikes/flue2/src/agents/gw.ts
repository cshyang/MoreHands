'use agent';
// Gateway-simulation agent (owner-approved burst design). Mirrors reply_to_conversation:
// edits the ack row when an ack ts is known and unconsumed, else inserts a fresh reply row.
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import { defineTool, useAgentFinish, useAgentStart, useDelivery, useModel, usePersistentState, useResponseStart, useTool, type AgentProps } from '@flue/runtime';

const db = () => (env as any).DB as D1Database;
async function row(conv: string, kind: string, key: string, text: string, extra = '') {
  await db().prepare('INSERT INTO gwrows(conv, kind, key, text, extra, ts) VALUES (?,?,?,?,?,?)').bind(conv, kind, key, text, extra, Date.now()).run();
}

export function Gw({ id }: AgentProps) {
  const d = useDelivery();
  const [ack, setAck] = usePersistentState<string | null>('ack', null); // latest ack ts seen by a start seam
  const [used, setUsed] = usePersistentState<string[]>('used_acks', []); // acks already edited into a reply
  const attrs = d.kind === 'signal' ? d.attributes ?? {} : {};
  useModel('zai/glm-5.3-flash'); // owner rule: flash only, no per-delivery model override

  useAgentStart(async () => {
    // Runs once per delivered message, including joined ones.
    await row(id, 'start', attrs.eventId ?? '', d.kind === 'signal' ? d.body : '', `sender=${attrs.sender ?? ''} ackTs=${attrs.ackTs ?? ''}`);
    if (attrs.ackTs) setAck(attrs.ackTs);
  });

  // Reply cap: at most 2 accepted reply calls per response. Counter resets at the response's true start.
  useResponseStart(() => {
    void db().prepare('INSERT OR REPLACE INTO gwcap(conv, n) VALUES (?, 0)').bind(id).run();
  });

  useTool(
    defineTool({
      name: 'reply',
      description: 'Send a reply into the Slack thread.',
      input: v.object({ text: v.string() }),
      run: async ({ data, toolCallId }) => {
        const cap = await db().prepare('SELECT n FROM gwcap WHERE conv=?').bind(id).first<{ n: number }>();
        if ((cap?.n ?? 0) >= 2) {
          await row(id, 'cap_hit', toolCallId, data.text);
          return 'REFUSED: you already sent 2 replies in this response. End your turn now.';
        }
        await db().prepare('INSERT OR REPLACE INTO gwcap(conv, n) VALUES (?, ?)').bind(id, (cap?.n ?? 0) + 1).run();
        await row(id, 'reply_call', toolCallId, data.text);
        // The start seam's state write is not visible to the first model call's render, so read the
        // delivery attribute first and fall back to the persisted ack (covers joined deliveries).
        const candidate = attrs.ackTs ?? ack;
        if (candidate && !used.includes(candidate)) {
          await db().prepare("UPDATE gwrows SET text=?, extra='edited' WHERE conv=? AND kind='ack' AND key=?").bind(data.text, id, candidate).run();
          setUsed((prev) => [...(prev ?? []), candidate]);
        } else {
          await row(id, 'reply_fresh', '', data.text);
        }
        return 'sent';
      },
    }),
  );

  // Finish check: if no accepted reply came after the newest delivered message, name the unanswered
  // messages and send the model back to work. Skipped once the reply cap was hit.
  useAgentFinish(async ({ append }) => {
    const lastReply = (await db().prepare("SELECT MAX(seq) AS m FROM gwrows WHERE conv=? AND kind='reply_call'").bind(id).first<{ m: number | null }>())?.m ?? 0;
    const cap = await db().prepare('SELECT n FROM gwcap WHERE conv=?').bind(id).first<{ n: number }>();
    if ((cap?.n ?? 0) >= 2) return;
    const { results } = await db().prepare("SELECT text, extra FROM gwrows WHERE conv=? AND kind='start' AND seq>? ORDER BY seq").bind(id, lastReply).all<{ text: string; extra: string }>();
    if (results?.length) {
      await row(id, 'finish_nudge', '', '');
      const list = results.map((r) => `- ${(r.extra.match(/sender=(\w*)/)?.[1] ?? '?')}: ${r.text.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
      append({ kind: 'signal', type: 'reply.missing', body: `You have not replied to these messages yet:\n${list}\nCall reply now with one answer that covers them all.` });
    }
  });

  return (
    'You are a Slack assistant in one thread. Messages arrive as signals; the sender is in the signal attributes. ' +
    'Answer each person\'s question by calling reply. Start each answer with "@<sender>: ". ' +
    'If several questions have arrived, one reply covering all of them is best. Never answer a question you already answered. ' +
    'Do not use any other tool.'
  );
}
