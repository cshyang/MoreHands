'use agent';
// Retry-ownership test agent. slow_step records each time it RUNS (before sleeping ~20s);
// post_reply stands in for the Slack post. The real model (zai/glm-5.3-flash) drives the calls.
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import { defineTool, useDelivery, useModel, useTool, type AgentProps } from '@flue/runtime';

function useRetryBody(id: string): string {
  const delivery = useDelivery();
  const model = delivery.kind === 'signal' ? delivery.attributes?.model : undefined;
  useModel(model ?? 'zai/glm-5.3-flash');
  const db = (env as any).DB as D1Database;
  useTool(
    defineTool({
      name: 'slow_step',
      description: 'A slow step (takes ~20 seconds). Call it exactly once.',
      input: v.object({}),
      run: async ({ toolCallId }) => {
        await db.prepare('INSERT INTO tool_calls(instance_id, submission_id, attempt_ts) VALUES (?,?,?)').bind(id, toolCallId, Date.now()).run();
        await new Promise((r) => setTimeout(r, 20_000));
        return 'slow step finished';
      },
    }),
  );
  useTool(
    defineTool({
      name: 'post_reply',
      description: 'Post the final reply to the user. Call it exactly once, after slow_step.',
      input: v.object({ text: v.string() }),
      run: async ({ data, toolCallId }) => {
        await db.prepare('INSERT INTO replies(instance_id, submission_id, text, ts) VALUES (?,?,?,?)').bind(id, toolCallId, data.text, Date.now()).run();
        return 'posted';
      },
    }),
  );
  return 'You are a test agent. When asked, call slow_step exactly once, then post_reply exactly once with the text "done", then stop. Never call a tool twice.';
}

export function Retry({ id }: AgentProps) {
  return useRetryBody(id);
}

export function RetryOnce({ id }: AgentProps) {
  return useRetryBody(id);
}
RetryOnce.durability = { maxAttempts: 1 };
