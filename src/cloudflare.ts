// Worker-level exports and product-task cron clock. Flue composes these non-HTTP
// handlers with app.ts; agent liveness is owned by the runtime's Durable Object alarms.
// Each task calls the existing token-guarded internal routes in-process via app.fetch.

import { DurableObject } from 'cloudflare:workers';
import type { D1Like } from './skills/repository';
import { takeDueReminders } from './gateway/reminders-store';
import { handleScheduledJob } from './gateway/scheduled-dispatch';
import { beginIntake } from './cutover/admissions';
import { createProducerScope } from './cutover/producer';
import app from './app';
import { withIngressBudget, remainingIngressBudget } from './slack/ingress-budget';

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

async function scanReminders(env: ScheduledEnv): Promise<void> {
  const scope = createProducerScope(env, await beginIntake(env, 'g2', 'reminder-scan'));
  let succeeded = false;
  try {
    if (!env.DB) { succeeded = true; return; }
    const due = await takeDueReminders(env.DB);
    for (const job of due) {
      // The scan already owns admission; a second HTTP gate could reject a consumed one-shot.
      const result = await handleScheduledJob(env, job);
      if (result.status >= 400) throw new Error('scheduled dispatch incomplete');
    }
    succeeded = true;
  } finally { await scope.finish(succeeded); }
}

export default {
  async scheduled(controller: { cron?: string; scheduledTime?: number }, env: ScheduledEnv, ctx: ExecutionCtx): Promise<void> {
    if (!env.HEARTBEAT_TOKEN) return;
    let job: Promise<void>;
    switch (controller.cron) {
      case REMINDERS_CRON:
        job = scanReminders(env);
        break;
      case RECONCILE_CRON:
        env = withIngressBudget(env);
        job = (async () => {
          const phases = [
            { path: '/__internal/agent-runs/reconcile', minimum: 13 },
            { path: '/__internal/replies/reconcile', minimum: 8 },
            { path: '/__internal/review-sweep', minimum: 23 },
            { path: '/__internal/slack-ingress/reconcile', minimum: 10 },
          ];
          const first = Math.floor((controller.scheduledTime ?? Date.now()) / 120_000) % phases.length;
          for (let index = 0; index < phases.length; index++) {
            const phase = phases[(first + index) % phases.length];
            if (env.DB && remainingIngressBudget(env.DB) < phase.minimum) continue;
            await callInternal(env, ctx, phase.path, {});
          }
        })();
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
