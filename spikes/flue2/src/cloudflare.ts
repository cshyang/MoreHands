// Same pattern as MoreHands' .flue/cloudflare.ts: named export for the Sandbox DO class,
// default export with a scheduled() handler that calls our own routes in-process via app.fetch.
import app from './app';

export { Sandbox } from '@cloudflare/sandbox';

type ExecutionCtx = { waitUntil(p: Promise<unknown>): void };

export default {
  async scheduled(controller: { cron?: string }, env: Record<string, unknown>, ctx: ExecutionCtx): Promise<void> {
    const res = await app.fetch(
      new Request('https://spike.internal/go', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'project:cron:agent:default/heartbeat',
          message: { kind: 'signal', type: 'heartbeat', body: `cron ${controller.cron}` },
        }),
      }),
      env,
      ctx as any,
    );
    console.log(`[cron] ${controller.cron} -> HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  },
};
