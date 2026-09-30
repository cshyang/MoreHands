'use agent';
// Gateway-simulation agent (owner-approved burst design). Mirrors reply_to_conversation:
// edits the ack row when an ack ts is known and unconsumed, else inserts a fresh reply row.
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import { defineTool, useAgentFinish, useAgentStart, useDelivery, useModel, usePersistentState, useTool, type AgentProps } from '@flue/runtime';

const db = () => (env as any).DB as D1Database;
async function row(conv: string, kind: string, key: string, text: string, extra = '') {
  await db().prepare('INSERT INTO gwrows(conv, kind, key, text, extra, ts) VALUES (?,?,?,?,?,?)').bind(conv, kind, key, text, extra, Date.now()).run();
}

export function Gw({ id }: AgentProps) {
  const d = useDelivery();
  const [ack, setAck] = usePersistentState<string | null>('ack', null); // latest ack ts seen by a start seam
  const [used, setUsed] = usePersistentState<string[]>('used_acks', []); // acks already edited into a reply
  const attrs = d.kind === 'signal' ? d.attributes ?? {} : {};
  useModel(attrs.model || 'zai/glm-5.3-flash');

  useAgentStart(async () => {
    // Runs once per delivered message, including joined ones.
    await row(id, 'start', attrs.eventId ?? '', '', `sender=${attrs.sender ?? ''} ackTs=${attrs.ackTs ?? ''}`);
    if (attrs.ackTs) setAck(attrs.ackTs);
  });

  useTool(
    defineTool({
      name: 'reply',
      description: 'Send a reply into the Slack thread.',
      input: v.object({ text: v.string() }),
      run: async ({ data, toolCallId }) => {
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

  // Finish check. Runs 2-4: nudge only when the whole response made NO reply call.
  // Run 5 (fix): nudge whenever no reply call came after the newest delivered message
  // (probe stand-in for a persistent-state counter of deliveries vs replies).
  useAgentFinish(async ({ append }) => {
    const last = async (kind: string) => (await db().prepare('SELECT MAX(seq) AS m FROM gwrows WHERE conv=? AND kind=?').bind(id, kind).first<{ m: number | null }>())?.m ?? 0;
    const unanswered = (await last('start')) > (await last('reply_call'));
    if (unanswered) {
      await row(id, 'finish_nudge', '', '');
      append({ kind: 'signal', type: 'reply.missing', body: 'No reply has been sent since the newest message arrived. Call reply now with an answer that covers every question you have not yet answered.' });
    }
  });

  return (
    'You are a Slack assistant in one thread. Messages arrive as signals; the sender is in the signal attributes. ' +
    'Answer each person\'s question by calling reply. Start each answer with "@<sender>: ". ' +
    'If several questions have arrived, one reply covering all of them is best. Never answer a question you already answered. ' +
    'Do not use any other tool.'
  );
}
