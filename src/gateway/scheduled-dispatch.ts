import type { D1Like } from '../skills/repository';
import { claimEvent, type KVLike } from '../shared/idempotency';
import { bindingByProject, agentInstanceId } from '../project/bindings';
import { buildScheduledInput } from './scheduled';
import { dispatchProject } from './dispatch';

export interface ScheduledDispatchEnv extends Record<string, unknown> {
  DB?: D1Like;
  SLACK_EVENTS?: KVLike;
}

// Already-admitted work only. Authentication and producer ownership belong to the caller.
export async function handleScheduledJob(env: ScheduledDispatchEnv, value: unknown): Promise<{
  status: number; body: Record<string, unknown>;
}> {
  const body = value as { fireId?: string; projectId?: string; jobId?: string; kind?: string; payload?: Record<string, unknown> } | null;
  if (!body?.fireId || !body.projectId || !body.jobId) return { status: 400, body: { error: 'bad request' } };
  if (!(await claimEvent(env.SLACK_EVENTS, `sched:${body.fireId}`))) return { status: 200, body: { deduped: true } };
  const binding = await bindingByProject(body.projectId, env.DB);
  if (!binding || binding.status !== 'active') return { status: 200, body: { skipped: 'no active binding' } };
  const scheduled = await buildScheduledInput({
    db: env.DB, projectId: body.projectId, kind: body.kind, payload: body.payload, now: new Date().toISOString(),
  });
  if (scheduled.skipped) return { status: 200, body: { skipped: scheduled.skipped } };
  await dispatchProject(env, {
    agent: 'project', id: agentInstanceId(body.projectId, `job:${body.jobId}`),
    idempotencyKey: `sched:${body.fireId}`, input: scheduled.input,
  });
  return { status: 200, body: { dispatched: true, jobId: body.jobId, skill: scheduled.input.skill ?? null } };
}
