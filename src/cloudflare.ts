// Worker-level exports and product-task cron clock. Flue composes these non-HTTP
// handlers with app.ts; agent liveness is owned by the runtime's Durable Object alarms.
// Each task calls the existing token-guarded internal routes in-process via app.fetch.

import { DurableObject } from 'cloudflare:workers';
import type { D1Like } from './skills/repository';
import { takeDueReminders } from './gateway/reminders-store';
import app from './app';

export { Sandbox } from '@cloudflare/sandbox';

// Keep the retired registry namespace exported so its existing SQLite data survives
// the cutover. No binding or new traffic uses it; deleting its class destroys storage.
export class FlueRegistry extends DurableObject {
  async fetch(): Promise<Response> {
    return new Response('Registry retired', { status: 404 });
  }
}

export const REFLECT_CRON = '0 19 * * *'; // nightly REM at 03:00 KL (UTC+8, crons are UTC)
export const RECONCILE_CRON = '*/2 * * * *'; // agent-run outbox backstop
export const REMINDERS_CRON = '* * * * *'; // due-scan for agent-set reminders (minute precision)

interface ScheduledEnv {
  HEARTBEAT_TOKEN?: string;
  DB?: D1Like;
  [binding: string]: unknown;
}

// The scheduled() controller context — structurally a subset of ExecutionContext;
// Hono's app.fetch only ever calls waitUntil, so the cast below is safe.
type ExecutionCtx = { waitUntil(p: Promise<unknown>): void };

// Call one of our own internal routes without leaving the Worker. The URL host is
// irrelevant (never resolved); the token guard in the route still applies.
async function callInternal(env: ScheduledEnv, ctx: ExecutionCtx, path: string, body: unknown): Promise<void> {
  const res = await app.fetch(
    new Request(`https://hatchery.internal${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-morehands-token': env.HEARTBEAT_TOKEN ?? '' },
      body: JSON.stringify(body ?? {}),
    }),
    env,
    ctx as Parameters<typeof app.fetch>[2],
  );
  const text = (await res.text()).slice(0, 160);
  console.log(`[cron] ${path} -> HTTP ${res.status}: ${text}`);
}

async function scanReminders(env: ScheduledEnv, ctx: ExecutionCtx): Promise<void> {
  if (!env.DB) return;
  const due = await takeDueReminders(env.DB);
  for (const job of due) {
    // Same body shape the SchedulerDO used to POST; the route's KV fireId claim and
    // active-binding gate are unchanged.
    await callInternal(env, ctx, '/__internal/scheduled', job);
  }
}

export default {
  async scheduled(controller: { cron?: string }, env: ScheduledEnv, ctx: ExecutionCtx): Promise<void> {
    if (!env.HEARTBEAT_TOKEN) return;
    let job: Promise<void>;
    switch (controller.cron) {
      case REMINDERS_CRON:
        job = scanReminders(env, ctx);
        break;
      case RECONCILE_CRON:
        job = Promise.all([
          callInternal(env, ctx, '/__internal/agent-runs/reconcile', {}),
          callInternal(env, ctx, '/__internal/replies/reconcile', {}),
          // Layer 4 shares the 2-min tick; the review-sweep gate is one cheap SQL query.
          callInternal(env, ctx, '/__internal/review-sweep', {}),
        ]).then(() => undefined);
        break;
      case REFLECT_CRON:
        job = callInternal(env, ctx, '/__internal/reflect-sweep', {});
        break;
      default:
        return;
    }
    ctx.waitUntil(job.catch((e) => console.log(`[cron] ${controller.cron} failed: ${e instanceof Error ? e.message : String(e)}`)));
  },
};
