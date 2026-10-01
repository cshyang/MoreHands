// Agent-run control-plane invariants — run: npx tsx src/agent-runs/agent-runs.test.ts
import assert from 'node:assert/strict';
import { createTestRunner, invokeTool } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';
import { claimRunForDispatch, createAgentRun, findLatestRunByLinearIssue, getActiveAgentRunByBranch, getAgentRun, getAgentRunById, handleAgentRunCallback, updateAgentRun } from './repository';
import { buildRunnerDispatch, claimAndDispatchRun, DISPATCH_MAX_ATTEMPTS, dispatchConcurrencyKey, reconcileAgentRuns, resolveDispatchGithubToken } from './dispatch';
import { adHocIdentifier, assignCodingRunTool } from './assign-tool';
import { checkAgentRunsTool } from './status-tool';
import type { AgentRun } from './repository';

const { test, run } = createTestRunner();

type Row = Record<string, unknown>;

class FakeD1 implements D1Like {
  agentRuns: Row[] = [];
  events: Row[] = [];
  notifications: Row[] = [];
  routes: Row[] = [];
  beforeUpdateAgentRun?: (row: Row, nextStatus: unknown) => void;

  prepare(query: string) {
    const db = this;
    return {
      bind(...values: unknown[]) {
        return {
          async first<T = Row>(): Promise<T | null> {
            const { results } = await this.all<T>();
            return results[0] ?? null;
          },
          async all<T = Row>(): Promise<{ results: T[] }> {
            if (query.startsWith('SELECT') && query.includes('FROM agent_runs')) {
              if (query.includes('WHERE project_id=? AND id=?')) {
                const [projectId, id] = values;
                return { results: db.agentRuns.filter((r) => r.project_id === projectId && r.id === id) as T[] };
              }
              if (query.includes('WHERE id=?')) {
                const [id] = values;
                return { results: db.agentRuns.filter((r) => r.id === id) as T[] };
              }
              if (query.includes('WHERE project_id=? AND source_type=? AND source_id=?')) {
                const [projectId, sourceType, sourceId] = values;
                const rows = db.agentRuns
                  .filter((r) => r.project_id === projectId && r.source_type === sourceType && r.source_id === sourceId)
                  .sort((a, b) => Number(b.created_at) - Number(a.created_at));
                return { results: rows as T[] };
              }
              if (query.includes('WHERE project_id=? AND idempotency_key=?')) {
                const [projectId, idempotencyKey] = values;
                return { results: db.agentRuns.filter((r) => r.project_id === projectId && r.idempotency_key === idempotencyKey) as T[] };
              }
              if (query.includes('WHERE project_id=? AND linear_issue_id=?')) {
                const [projectId, linearIssueId] = values;
                const rows = db.agentRuns
                  .filter((r) => r.project_id === projectId && r.linear_issue_id === linearIssueId)
                  .sort((a, b) => Number(b.created_at) - Number(a.created_at));
                return { results: rows as T[] };
              }
              if (query.includes('WHERE linear_issue_id=?')) {
                const [linearIssueId] = values;
                const rows = db.agentRuns
                  .filter((r) => r.linear_issue_id === linearIssueId)
                  .sort((a, b) => Number(b.created_at) - Number(a.created_at));
                return { results: rows as T[] };
              }
              if (query.includes("status IN ('queued'")) {
                const [projectId, branch] = values;
                const activeStatuses = new Set(['queued', 'dispatching', 'running']);
                const rows = db.agentRuns
                  .filter((r) => r.project_id === projectId && r.branch === branch && activeStatuses.has(String(r.status)))
                  .sort((a, b) => Number(b.created_at) - Number(a.created_at));
                return { results: rows as T[] };
              }
              if (query.includes("WHERE status='queued'")) {
                const [limit] = values;
                const rows = db.agentRuns
                  .filter((r) => r.status === 'queued')
                  .sort((a, b) => Number(a.created_at) - Number(b.created_at))
                  .slice(0, Number(limit));
                return { results: rows as T[] };
              }
              if (query.includes("WHERE status='dispatching' AND updated_at < ?")) {
                const [cutoff, limit] = values;
                const rows = db.agentRuns
                  .filter((r) => r.status === 'dispatching' && Number(r.updated_at) < Number(cutoff))
                  .sort((a, b) => Number(a.updated_at) - Number(b.updated_at))
                  .slice(0, Number(limit));
                return { results: rows as T[] };
              }
              if (query.includes("WHERE status='running' AND COALESCE")) {
                const [cutoff, limit] = values;
                const liveness = (r: Row) => Number(r.last_heartbeat_at ?? r.dispatched_at ?? r.updated_at);
                const rows = db.agentRuns
                  .filter((r) => r.status === 'running' && liveness(r) < Number(cutoff))
                  .sort((a, b) => Number(a.updated_at) - Number(b.updated_at))
                  .slice(0, Number(limit));
                return { results: rows as T[] };
              }
              if (query.includes('(linear_identifier=? OR linear_issue_id=?)')) {
                const [projectId, identifier, issueId] = values;
                const rows = db.agentRuns
                  .filter((r) => r.project_id === projectId && (r.linear_identifier === identifier || r.linear_issue_id === issueId))
                  .sort((a, b) => Number(b.created_at) - Number(a.created_at));
                return { results: rows as T[] };
              }
              if (query.includes('WHERE project_id=? ORDER BY created_at DESC')) {
                const [projectId, limit] = values;
                const rows = db.agentRuns
                  .filter((r) => r.project_id === projectId)
                  .sort((a, b) => Number(b.created_at) - Number(a.created_at))
                  .slice(0, Number(limit));
                return { results: rows as T[] };
              }
            }
            if (query.startsWith('SELECT') && query.includes('FROM agent_run_routes')) {
              if (query.includes("WHERE project_id=? AND status='active'")) {
                const [projectId] = values;
                const rows = db.routes
                  .filter((r) => r.project_id === projectId && r.status === 'active')
                  .sort((a, b) => Number(b.priority ?? 0) - Number(a.priority ?? 0));
                return { results: rows as T[] };
              }
            }
            if (query.startsWith('SELECT') && query.includes('FROM agent_run_events')) {
              if (query.includes('WHERE dedupe_key=?')) {
                const [dedupeKey] = values;
                return { results: db.events.filter((r) => r.dedupe_key === dedupeKey) as T[] };
              }
            }
            if (query.startsWith('SELECT') && query.includes('FROM agent_run_notifications')) {
              if (query.includes('WHERE dedupe_key=?')) {
                const [dedupeKey] = values;
                return { results: db.notifications.filter((r) => r.dedupe_key === dedupeKey) as T[] };
              }
            }
            return { results: [] as T[] };
          },
          async run(): Promise<{ meta: { changes: number } }> {
            if (query.startsWith('INSERT INTO agent_runs')) {
              const [
                id,
                projectId,
                routeId,
                sourceType,
                sourceId,
                idempotencyKey,
                linearIssueId,
                linearIdentifier,
                linearUrl,
                slackTeamId,
                slackChannelId,
                slackThreadTs,
                githubOwner,
                githubRepo,
                targetRepo,
                baseBranch,
                kit,
                runtime,
                sandboxProvider,
                sandboxId,
                triggerRunId,
                status,
                branch,
                commitSha,
                prUrl,
                ciUrl,
                summary,
                error,
                statusNote,
                lastEventId,
                lastHeartbeatAt,
                dispatchPayload,
                createdAt,
                updatedAt,
                completedAt,
              ] = values;
              db.agentRuns.push({
                id,
                project_id: projectId,
                route_id: routeId,
                source_type: sourceType,
                source_id: sourceId,
                idempotency_key: idempotencyKey,
                linear_issue_id: linearIssueId,
                linear_identifier: linearIdentifier,
                linear_url: linearUrl,
                slack_team_id: slackTeamId,
                slack_channel_id: slackChannelId,
                slack_thread_ts: slackThreadTs,
                github_owner: githubOwner,
                github_repo: githubRepo,
                target_repo: targetRepo,
                base_branch: baseBranch,
                kit,
                runtime,
                sandbox_provider: sandboxProvider,
                sandbox_id: sandboxId,
                trigger_run_id: triggerRunId,
                status,
                branch,
                commit_sha: commitSha,
                pr_url: prUrl,
                ci_url: ciUrl,
                summary,
                error,
                status_note: statusNote,
                last_event_id: lastEventId,
                last_heartbeat_at: lastHeartbeatAt,
                dispatch_attempts: 0,
                last_dispatch_error: null,
                dispatched_at: null,
                dispatch_payload: dispatchPayload,
                created_at: createdAt,
                updated_at: updatedAt,
                completed_at: completedAt,
              });
              return { meta: { changes: 1 } };
            }
            // Atomic claim: queued -> dispatching. Compare-and-set on status, so a row already
            // claimed (or terminal) yields changes:0 — the same guard the real SQL enforces.
            if (query.startsWith('UPDATE agent_runs') && query.includes("status='dispatching'") && query.includes("AND status='queued'")) {
              const [dispatchedAt, updatedAt, id] = values;
              const row = db.agentRuns.find((r) => r.id === id && r.status === 'queued');
              if (!row) return { meta: { changes: 0 } };
              Object.assign(row, {
                status: 'dispatching',
                dispatch_attempts: (Number(row.dispatch_attempts) || 0) + 1,
                dispatched_at: dispatchedAt,
                updated_at: updatedAt,
              });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('UPDATE agent_runs') && query.includes("SET status='queued'") && query.includes("status='dispatching'")) {
              const [lastDispatchError, updatedAt, id, leaseCutoff] = values;
              const row = db.agentRuns.find((r) => r.id === id);
              if (!row) return { meta: { changes: 0 } };
              db.beforeUpdateAgentRun?.(row, 'queued');
              if (row.status !== 'dispatching' || Number(row.updated_at) >= Number(leaseCutoff)) return { meta: { changes: 0 } };
              Object.assign(row, {
                status: 'queued',
                last_dispatch_error: lastDispatchError,
                updated_at: updatedAt,
              });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('UPDATE agent_runs') && query.includes("SET status='failed'") && query.includes("status='running'")) {
              const [error, statusNote, completedAt, updatedAt, id, heartbeatCutoff] = values;
              const row = db.agentRuns.find((r) => r.id === id);
              if (!row) return { meta: { changes: 0 } };
              db.beforeUpdateAgentRun?.(row, 'failed');
              const liveness = Number(row.last_heartbeat_at ?? row.dispatched_at ?? row.updated_at);
              if (row.status !== 'running' || liveness >= Number(heartbeatCutoff)) return { meta: { changes: 0 } };
              Object.assign(row, {
                status: 'failed',
                error,
                status_note: statusNote,
                completed_at: completedAt,
                updated_at: updatedAt,
              });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('UPDATE agent_runs')) {
              const [status, sandboxId, triggerRunId, branch, commitSha, prUrl, ciUrl, summary, error, statusNote, lastEventId, lastHeartbeatAt, lastDispatchError, completedAt, updatedAt, id] = values;
              const row = db.agentRuns.find((r) => r.id === id);
              if (!row) return { meta: { changes: 0 } };
              db.beforeUpdateAgentRun?.(row, status);
              Object.assign(row, {
                status,
                sandbox_id: sandboxId,
                trigger_run_id: triggerRunId,
                branch,
                commit_sha: commitSha,
                pr_url: prUrl,
                ci_url: ciUrl,
                summary,
                error,
                status_note: statusNote,
                last_event_id: lastEventId,
                last_heartbeat_at: lastHeartbeatAt,
                last_dispatch_error: lastDispatchError,
                completed_at: completedAt,
                updated_at: updatedAt,
              });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('INSERT INTO agent_run_events')) {
              const [id, projectId, runId, provider, eventType, providerDeliveryId, providerEntityId, dedupeKey, actorType, handling, handlingReason, payloadJson, occurredAt, receivedAt, processedAt, createdAt] = values;
              if (db.events.some((r) => r.dedupe_key === dedupeKey)) return { meta: { changes: 0 } };
              db.events.push({
                id,
                project_id: projectId,
                run_id: runId,
                provider,
                event_type: eventType,
                provider_delivery_id: providerDeliveryId,
                provider_entity_id: providerEntityId,
                dedupe_key: dedupeKey,
                actor_type: actorType,
                handling,
                handling_reason: handlingReason,
                payload_json: payloadJson,
                occurred_at: occurredAt,
                received_at: receivedAt,
                processed_at: processedAt,
                created_at: createdAt,
              });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('INSERT INTO agent_run_notifications')) {
              const [id, projectId, runId, channel, notificationType, dedupeKey, targetRef, status, providerMessageId, error, createdAt, sentAt] = values;
              if (db.notifications.some((r) => r.dedupe_key === dedupeKey)) return { meta: { changes: 0 } };
              db.notifications.push({
                id,
                project_id: projectId,
                run_id: runId,
                channel,
                notification_type: notificationType,
                dedupe_key: dedupeKey,
                target_ref: targetRef,
                status,
                provider_message_id: providerMessageId,
                error,
                created_at: createdAt,
                sent_at: sentAt,
              });
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
        };
      },
    };
  }
}

function seq() {
  let n = 0;
  return {
    id: () => `run-${++n}`,
    now: () => 2000 + n,
  };
}

const runInput = {
  projectId: 'P',
  sourceType: 'linear',
  sourceId: 'LIN-42',
  idempotencyKey: 'linear:issue:issue-1:run-agent',
  linearIssueId: 'issue-1',
  linearIdentifier: 'LIN-42',
  linearUrl: 'https://linear.app/acme/issue/LIN-42/fix-it',
  targetRepo: 'github.com/acme/repo',
  baseBranch: 'main',
  kit: 'coding-default',
  runtime: 'pi',
  sandboxProvider: 'e2b',
};

function countNotification(db: FakeD1, type: string, channel?: string, runId?: string): number {
  return db.notifications.filter(
    (n) =>
      n.notification_type === type &&
      (!channel || n.channel === channel) &&
      (!runId || n.run_id === runId),
  ).length;
}

test('createAgentRun stores a project-scoped lease and dedupes by idempotency key', async () => {
  const db = new FakeD1();
  const deps = seq();

  const first = await createAgentRun(db, runInput, deps);
  const duplicate = await createAgentRun(db, { ...runInput, sourceId: 'LIN-42-again' }, deps);
  const otherProject = await createAgentRun(db, { ...runInput, projectId: 'OTHER' }, deps);

  assert.equal(first.duplicate, false);
  assert.equal(first.run.projectId, 'P');
  assert.equal(first.run.status, 'queued');
  assert.equal(first.run.runtime, 'pi');
  assert.equal(first.run.sandboxProvider, 'e2b');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.run.id, first.run.id);
  assert.equal(otherProject.duplicate, false);
});

test('handleAgentRunCallback rejects missing or wrong runner token', async () => {
  const denied = await handleAgentRunCallback(
    { db: new FakeD1(), expectedToken: 'runner-secret', actualToken: 'wrong', body: { runId: 'run-1', status: 'running' } },
    seq(),
  );
  assert.equal(denied.status, 404);
});

test('handleAgentRunCallback maps running, pr_opened, completed, and failed into run state', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createAgentRun(db, runInput, deps);

  const running = await handleAgentRunCallback(
    {
      db,
      expectedToken: 'runner-secret',
      actualToken: 'runner-secret',
      body: { runId: created.run.id, status: 'running', sandboxId: 'sbx_1', summary: 'started' },
    },
    deps,
  );
  assert.equal(running.status, 200);
  assert.equal(running.body?.run.status, 'running');
  assert.equal(running.body?.run.sandboxId, 'sbx_1');

  const pr = await handleAgentRunCallback(
    {
      db,
      expectedToken: 'runner-secret',
      actualToken: 'runner-secret',
      body: { runId: created.run.id, status: 'pr_opened', branch: 'agent/LIN-42', commitSha: 'abc123', prUrl: 'https://github.com/acme/repo/pull/7' },
    },
    deps,
  );
  assert.equal(pr.body?.run.status, 'waiting_approval');
  assert.equal(pr.body?.run.prUrl, 'https://github.com/acme/repo/pull/7');
  assert.equal(db.events.some((e) => e.event_type === 'runner.pr_opened'), true);
  assert.equal(countNotification(db, 'pr_opened', 'linear'), 1);
  assert.equal(countNotification(db, 'pr_opened', 'slack'), 1);

  const duplicatePr = await handleAgentRunCallback(
    {
      db,
      expectedToken: 'runner-secret',
      actualToken: 'runner-secret',
      body: { runId: created.run.id, status: 'pr_opened', branch: 'agent/LIN-42', commitSha: 'abc123', prUrl: 'https://github.com/acme/repo/pull/7' },
    },
    deps,
  );
  assert.equal(duplicatePr.body?.run.status, 'waiting_approval');
  assert.equal(countNotification(db, 'pr_opened', 'linear'), 1, 'duplicate runner echo does not double-notify Linear');
  assert.equal(countNotification(db, 'pr_opened', 'slack'), 1, 'duplicate runner echo does not double-notify Slack');

  const completed = await handleAgentRunCallback(
    {
      db,
      expectedToken: 'runner-secret',
      actualToken: 'runner-secret',
      body: { runId: created.run.id, status: 'completed', ciUrl: 'https://github.com/acme/repo/actions/runs/1', summary: 'ready' },
    },
    deps,
  );
  assert.equal(completed.body?.run.status, 'completed');
  assert.equal(completed.body?.run.ciUrl, 'https://github.com/acme/repo/actions/runs/1');
  assert.equal(completed.body?.run.prUrl, 'https://github.com/acme/repo/pull/7');
  assert.equal(completed.body?.run.branch, 'agent/LIN-42');
  assert.equal(countNotification(db, 'completed', 'linear'), 1);
  assert.equal(countNotification(db, 'completed', 'slack'), 1);

  const failedRun = await createAgentRun(db, { ...runInput, idempotencyKey: 'linear:issue:issue-2:run-agent', linearIssueId: 'issue-2' }, deps);
  const failed = await handleAgentRunCallback(
    {
      db,
      expectedToken: 'runner-secret',
      actualToken: 'runner-secret',
      body: { runId: failedRun.run.id, status: 'failed', error: 'tests failed' },
    },
    deps,
  );
  assert.equal(failed.body?.run.status, 'failed');
  assert.equal(failed.body?.run.error, 'tests failed');

  const readBack = await getAgentRun(db, 'P', created.run.id);
  assert.equal(readBack?.status, 'completed');
});

test('terminal agent runs cannot move back to running', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createAgentRun(db, runInput, deps);
  await handleAgentRunCallback(
    {
      db,
      expectedToken: 'runner-secret',
      actualToken: 'runner-secret',
      body: { runId: created.run.id, status: 'completed', summary: 'done' },
    },
    deps,
  );

  const resurrect = await handleAgentRunCallback(
    {
      db,
      expectedToken: 'runner-secret',
      actualToken: 'runner-secret',
      body: { runId: created.run.id, status: 'running', summary: 'late echo' },
    },
    deps,
  );

  assert.equal(resurrect.status, 400);
  assert.match(String(resurrect.body?.error), /terminal/i);
  const readBack = await getAgentRun(db, 'P', created.run.id);
  assert.equal(readBack?.status, 'completed');
  assert.equal(readBack?.summary, 'done');
});

// ── Outbox: atomic claim ─────────────────────────────────────────────────────
// A contract-valid INITIAL stored payload: full linearIssue snapshot + repo/branch/kit/runtime/provider.
// buildRunnerDispatch maps this to the runner contract and v.parses it, so the snapshot must be complete.
const initialDispatchPayload = JSON.stringify({
  source: { type: 'linear', id: 'LIN-42' },
  linearIssue: { id: 'issue-1', identifier: 'LIN-42', title: 'Fix it', description: 'do the thing', url: 'https://linear.app/acme/issue/LIN-42/fix-it' },
  targetRepo: 'https://github.com/acme/repo',
  baseBranch: 'main',
  kit: 'coding-default',
  runtime: 'pi',
  sandboxProvider: 'e2b',
});
const dispatchableInput = { ...runInput, dispatchPayload: initialDispatchPayload };
const okFetch = (async () => new Response(JSON.stringify({ id: 'run_x' }), { status: 200 })) as unknown as typeof fetch;
const retryableFetch = (async () => new Response('upstream boom', { status: 503 })) as unknown as typeof fetch;
const fatalFetch = (async () => new Response('bad request', { status: 400 })) as unknown as typeof fetch;
const runnerDeps = {
  triggerApiUrl: 'https://trigger.test',
  triggerSecretKey: 'tr_secret',
  githubToken: 'ghp_x',
  runnerToken: 'rt',
  moreHandsPublicUrl: 'https://hatchery.test',
};

test('claimRunForDispatch is compare-and-set: only the first claim wins', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createAgentRun(db, dispatchableInput, deps);

  const first = await claimRunForDispatch(db, created.run.id, deps);
  const second = await claimRunForDispatch(db, created.run.id, deps);

  assert.equal(first?.status, 'dispatching');
  assert.equal(first?.dispatchAttempts, 1, 'claim bumps the attempt counter');
  assert.equal(second, null, 'a row already claimed cannot be claimed again');
});

test('immediate dispatch: success moves queued -> running with trigger run id', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createAgentRun(db, dispatchableInput, deps);

  const result = await claimAndDispatchRun(db, created.run.id, { ...runnerDeps, fetch: okFetch }, deps);

  assert.equal(result.dispatched, true);
  const run = await getAgentRunById(db, created.run.id);
  assert.equal(run?.status, 'running');
  assert.equal(run?.triggerRunId, 'run_x');
});

test('immediate dispatch: an unconfigured runner leaves the run queued for the ticker (self-heals)', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createAgentRun(db, dispatchableInput, deps);

  const result = await claimAndDispatchRun(db, created.run.id, { fetch: okFetch }, deps);

  assert.equal(result.dispatched, false);
  assert.equal(result.status, 'skipped');
  const run = await getAgentRunById(db, created.run.id);
  assert.equal(run?.status, 'queued', 'never claimed → still dispatchable later');
  assert.equal(run?.dispatchAttempts, 0, 'a config gap does not burn an attempt');
});

test('transient runner failure requeues, then fails terminally at the attempt cap', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createAgentRun(db, dispatchableInput, deps);

  for (let i = 1; i < DISPATCH_MAX_ATTEMPTS; i++) {
    const r = await claimAndDispatchRun(db, created.run.id, { ...runnerDeps, fetch: retryableFetch }, deps);
    assert.equal(r.status, 'queued', `attempt ${i} should requeue`);
    const mid = await getAgentRunById(db, created.run.id);
    assert.equal(mid?.status, 'queued');
    assert.equal(mid?.dispatchAttempts, i);
    assert.match(String(mid?.lastDispatchError), /503/);
  }
  const last = await claimAndDispatchRun(db, created.run.id, { ...runnerDeps, fetch: retryableFetch }, deps);
  assert.equal(last.status, 'failed', 'the capped attempt is terminal');
  const run = await getAgentRunById(db, created.run.id);
  assert.equal(run?.status, 'failed');
  assert.equal(run?.dispatchAttempts, DISPATCH_MAX_ATTEMPTS);
});

test('a 4xx runner response fails immediately (not retryable)', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createAgentRun(db, dispatchableInput, deps);

  const result = await claimAndDispatchRun(db, created.run.id, { ...runnerDeps, fetch: fatalFetch }, deps);

  assert.equal(result.status, 'failed');
  const run = await getAgentRunById(db, created.run.id);
  assert.equal(run?.status, 'failed');
  assert.equal(run?.dispatchAttempts, 1, 'one attempt, no pointless retries');
});

// ── Outbox: payload → contract mapping ───────────────────────────────────────
const mappingDeps = { triggerApiUrl: 'https://trigger.test', triggerSecretKey: 'tr_secret', githubToken: 'ghp_x', runnerToken: 'rt', moreHandsPublicUrl: 'https://hatchery.test' };
const runWith = (dispatchPayload: string): AgentRun => ({ id: 'run-1', projectId: 'P', dispatchPayload } as unknown as AgentRun);

const continuationDispatchPayload = JSON.stringify({
  source: { type: 'linear', id: 'd2' },
  mode: 'continuation',
  parentRunId: 'run-parent',
  targetRepo: 'https://github.com/acme/repo',
  baseBranch: 'main',
  targetBranch: 'morehands/lin-42',
  prUrl: 'https://github.com/acme/repo/pull/7',
  kit: 'coding-default',
  runtime: 'pi',
  sandboxProvider: 'e2b',
  feedback: 'use the existing helper',
  replyTarget: { surface: 'linear', ref: 'issue-1' },
  linearIssue: { id: 'issue-1', identifier: 'LIN-42', url: 'https://linear.app/acme/issue/LIN-42/fix-it' },
});

test('buildRunnerDispatch maps an initial payload to a contract object (issue populated, mode initial, workspacePolicy defaults fresh)', () => {
  const dispatch = buildRunnerDispatch(runWith(initialDispatchPayload), mappingDeps);

  assert.equal(dispatch.mode, 'initial');
  assert.equal(dispatch.workspacePolicy, 'fresh');
  assert.deepEqual(dispatch.issue, { id: 'issue-1', identifier: 'LIN-42', url: 'https://linear.app/acme/issue/LIN-42/fix-it', title: 'Fix it', description: 'do the thing' });
  assert.equal(dispatch.targetBranch, null);
  assert.equal(dispatch.githubToken, 'ghp_x');
  assert.deepEqual(dispatch.callback, { url: 'https://hatchery.test/__internal/agent-runs', token: 'rt' });
});

test('buildRunnerDispatch maps a continuation payload with issue null and carries feedback/targetBranch/prUrl', () => {
  const dispatch = buildRunnerDispatch(runWith(continuationDispatchPayload), mappingDeps);

  assert.equal(dispatch.mode, 'continuation');
  assert.equal(dispatch.issue, null);
  assert.equal(dispatch.feedback, 'use the existing helper');
  assert.equal(dispatch.targetBranch, 'morehands/lin-42');
  assert.equal(dispatch.prUrl, 'https://github.com/acme/repo/pull/7');
});

test('buildRunnerDispatch on a payload with an unsupported runtime fails terminally (not retryable → run failed, no requeue)', async () => {
  const db = new FakeD1();
  const deps = seq();
  const legacyPayload = JSON.stringify({
    source: { type: 'linear', id: 'LIN-99' },
    linearIssue: { id: 'issue-9', identifier: 'LIN-99', title: 'Legacy', description: null, url: 'https://linear.app/acme/issue/LIN-99' },
    targetRepo: 'https://github.com/acme/repo',
    baseBranch: 'main',
    kit: 'coding-default',
    runtime: 'opencode', // rejected by the contract's v.literal('pi')
    sandboxProvider: 'e2b',
  });
  const created = await createAgentRun(db, { ...runInput, idempotencyKey: 'legacy-runtime', dispatchPayload: legacyPayload }, deps);

  const result = await claimAndDispatchRun(db, created.run.id, { ...runnerDeps, fetch: okFetch }, deps);

  assert.equal(result.status, 'failed', 'a malformed payload is fatal — retrying cannot fix it');
  const run = await getAgentRunById(db, created.run.id);
  assert.equal(run?.status, 'failed');
  assert.equal(run?.dispatchAttempts, 1, 'one attempt, no pointless requeue');
});

// ── GitHub token resolution at dispatch (M0c) ────────────────────────────────
// The github token is a send-time injection (never persisted): resolveDispatchGithubToken prefers the
// per-run connection token (App installation token via the broker), falling back to the transition PAT.

test('resolveDispatchGithubToken: the per-run connection token wins over the PAT fallback', async () => {
  const token = await resolveDispatchGithubToken(runWith(initialDispatchPayload), { githubToken: 'pat_fallback', resolveGithubToken: async () => 'ghs_app' });
  assert.equal(token, 'ghs_app');
});

test('resolveDispatchGithubToken: falls back to the PAT when the resolver yields null', async () => {
  const token = await resolveDispatchGithubToken(runWith(initialDispatchPayload), { githubToken: 'pat_fallback', resolveGithubToken: async () => null });
  assert.equal(token, 'pat_fallback');
});

test('resolveDispatchGithubToken: null when neither a connection token nor a PAT is available', async () => {
  const token = await resolveDispatchGithubToken(runWith(initialDispatchPayload), { resolveGithubToken: async () => null });
  assert.equal(token, null);
});

test('claimAndDispatchRun: a resolver counts as configured and its token reaches the dispatch payload (no PAT)', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createAgentRun(db, dispatchableInput, deps);
  let sentToken: string | undefined;
  const capturingFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sentToken = (JSON.parse(String(init?.body)) as { payload: { githubToken: string } }).payload.githubToken;
    return new Response(JSON.stringify({ id: 'run_x' }), { status: 200 });
  }) as unknown as typeof fetch;
  const noPatWithResolver = { triggerApiUrl: 'https://trigger.test', triggerSecretKey: 'tr_secret', runnerToken: 'rt', moreHandsPublicUrl: 'https://hatchery.test', resolveGithubToken: async () => 'ghs_app', fetch: capturingFetch };

  const result = await claimAndDispatchRun(db, created.run.id, noPatWithResolver, deps);

  assert.equal(result.dispatched, true, 'a configured resolver is enough — no RUNNER_GITHUB_PAT_TEMP needed');
  assert.equal(sentToken, 'ghs_app', 'the resolved connection token is what the runner receives');
});

test('claimAndDispatchRun: no connection token and no PAT → requeued with a clear "no github credential" error', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createAgentRun(db, dispatchableInput, deps);
  const noCred = { triggerApiUrl: 'https://trigger.test', triggerSecretKey: 'tr_secret', runnerToken: 'rt', moreHandsPublicUrl: 'https://hatchery.test', resolveGithubToken: async () => null, fetch: okFetch };

  const result = await claimAndDispatchRun(db, created.run.id, noCred, deps);

  assert.equal(result.status, 'queued', 'retryable — self-heals when the project connects a GitHub App');
  const run = await getAgentRunById(db, created.run.id);
  assert.match(String(run?.lastDispatchError), /no github credential/);
});

// ── Reconciler ───────────────────────────────────────────────────────────────
test('reconciler reclaims a run stuck in dispatching past the lease', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createAgentRun(db, dispatchableInput, deps);
  const row = db.agentRuns.find((r) => r.id === created.run.id)!;
  row.status = 'dispatching';
  row.updated_at = 1_000; // ancient → lease expired
  row.dispatch_attempts = 1;

  // Unconfigured runner so we observe the reclaim in isolation (no same-tick re-dispatch).
  const summary = await reconcileAgentRuns(db, {}, { now: () => 10_000_000, id: () => 'x' });

  assert.equal(summary.reclaimed, 1);
  const run = await getAgentRunById(db, created.run.id);
  assert.equal(run?.status, 'queued');
  assert.match(String(run?.lastDispatchError), /lease expired/);
});

test('reconciler does not requeue a stale dispatching run after a callback moves it forward', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createAgentRun(db, dispatchableInput, deps);
  const row = db.agentRuns.find((r) => r.id === created.run.id)!;
  row.status = 'dispatching';
  row.updated_at = 1_000;
  row.dispatch_attempts = 1;
  db.beforeUpdateAgentRun = (run, nextStatus) => {
    if (run.id === created.run.id && nextStatus === 'queued') {
      run.status = 'running';
      run.sandbox_id = 'sbx_callback';
      run.updated_at = 9_999_999;
    }
  };

  const summary = await reconcileAgentRuns(db, {}, { now: () => 10_000_000, id: () => 'x' });

  assert.equal(summary.reclaimed, 0);
  const run = await getAgentRunById(db, created.run.id);
  assert.equal(run?.status, 'running');
  assert.equal(run?.sandboxId, 'sbx_callback');
});

test('reconciler times out a running run whose heartbeat went stale, and notifies', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createAgentRun(db, dispatchableInput, deps);
  const row = db.agentRuns.find((r) => r.id === created.run.id)!;
  row.status = 'running';
  row.last_heartbeat_at = 1_000; // long dead

  // now well past RUNNING_STALE_MS (3h) since the last heartbeat at t=1000.
  const summary = await reconcileAgentRuns(db, runnerDeps, { now: () => 20_000_000, id: () => 'x' });

  assert.equal(summary.timedOut, 1);
  const run = await getAgentRunById(db, created.run.id);
  assert.equal(run?.status, 'failed');
  assert.match(String(run?.error), /heartbeat stale/);
  assert.equal(countNotification(db, 'failed', 'linear', created.run.id), 1);
  assert.equal(countNotification(db, 'failed', 'slack', created.run.id), 1);
});

test('reconciler does not fail a stale running run after a fresh callback updates it', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createAgentRun(db, dispatchableInput, deps);
  const row = db.agentRuns.find((r) => r.id === created.run.id)!;
  row.status = 'running';
  row.last_heartbeat_at = 1_000;
  db.beforeUpdateAgentRun = (run, nextStatus) => {
    if (run.id === created.run.id && nextStatus === 'failed') {
      run.last_heartbeat_at = 19_999_999;
      run.updated_at = 19_999_999;
    }
  };

  const summary = await reconcileAgentRuns(db, runnerDeps, { now: () => 20_000_000, id: () => 'x' });

  assert.equal(summary.timedOut, 0);
  const run = await getAgentRunById(db, created.run.id);
  assert.equal(run?.status, 'running');
  assert.equal(run?.lastHeartbeatAt, 19_999_999);
  assert.equal(db.notifications.filter((n) => n.run_id === created.run.id && n.notification_type === 'failed').length, 0);
});

test('reconciler dispatches the queued backlog', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createAgentRun(db, dispatchableInput, deps);

  const summary = await reconcileAgentRuns(db, { ...runnerDeps, fetch: okFetch }, { now: () => 10_000_000, id: () => 'x' });

  assert.equal(summary.dispatched, 1);
  const run = await getAgentRunById(db, created.run.id);
  assert.equal(run?.status, 'running');
});

test('late running callback refreshes heartbeat without downgrading waiting_approval', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createAgentRun(db, runInput, deps);
  await handleAgentRunCallback(
    {
      db,
      expectedToken: 'runner-secret',
      actualToken: 'runner-secret',
      body: { runId: created.run.id, status: 'pr_opened', prUrl: 'https://github.com/acme/repo/pull/7' },
    },
    deps,
  );

  const lateRunning = await handleAgentRunCallback(
    {
      db,
      expectedToken: 'runner-secret',
      actualToken: 'runner-secret',
      body: { runId: created.run.id, status: 'running', summary: 'still working' },
    },
    { ...deps, now: () => 9_999 },
  );

  assert.equal(lateRunning.status, 200);
  assert.equal(lateRunning.body?.run.status, 'waiting_approval');
  assert.equal(lateRunning.body?.run.lastHeartbeatAt, 9_999);
});

// ── handleAgentRunCallback reply field ───────────────────────────────────────

test('handleAgentRunCallback pr_opened sets reply with type/issueId/prUrl when linearIssueId is set', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createAgentRun(db, runInput, deps);

  const result = await handleAgentRunCallback(
    {
      db,
      expectedToken: 'runner-secret',
      actualToken: 'runner-secret',
      body: { runId: created.run.id, status: 'pr_opened', prUrl: 'https://github.com/acme/repo/pull/99' },
    },
    deps,
  );

  assert.equal(result.status, 200);
  assert.ok(result.reply, 'reply should be present for a new pr_opened notification with linearIssueId');
  assert.equal(result.reply!.type, 'pr_opened');
  assert.equal(result.reply!.issueId, 'issue-1');
  assert.equal(result.reply!.prUrl, 'https://github.com/acme/repo/pull/99');
});

test('handleAgentRunCallback duplicate pr_opened redelivery does not set reply (no double-post)', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createAgentRun(db, runInput, deps);

  const callbackArgs = {
    db,
    expectedToken: 'runner-secret',
    actualToken: 'runner-secret',
    body: { runId: created.run.id, status: 'pr_opened', prUrl: 'https://github.com/acme/repo/pull/99' },
  };

  const first = await handleAgentRunCallback(callbackArgs, deps);
  assert.ok(first.reply, 'first delivery should have reply');

  const second = await handleAgentRunCallback(callbackArgs, deps);
  assert.equal(second.reply, undefined, 'duplicate redelivery must not carry reply (prevents double-post)');
});

test('handleAgentRunCallback no reply when linearIssueId is null', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createAgentRun(db, { ...runInput, linearIssueId: null }, deps);

  const result = await handleAgentRunCallback(
    {
      db,
      expectedToken: 'runner-secret',
      actualToken: 'runner-secret',
      body: { runId: created.run.id, status: 'pr_opened', prUrl: 'https://github.com/acme/repo/pull/1' },
    },
    deps,
  );

  assert.equal(result.reply, undefined, 'no reply when run has no linearIssueId');
});

test('findLatestRunByLinearIssue returns the newest run for an issue across projects', async () => {
  const db = new FakeD1();
  await createAgentRun(db, { projectId: 'p1', sourceType: 'linear', idempotencyKey: 'a', targetRepo: 'r', linearIssueId: 'ISSUE-1' }, seq());
  const found = await findLatestRunByLinearIssue(db, 'ISSUE-1');
  assert.equal(found?.projectId, 'p1');
});

test('getActiveAgentRunByBranch finds queued/dispatching/running, ignores terminal and waiting', async () => {
  const db = new FakeD1();
  const { run } = await createAgentRun(db, { projectId: 'p1', sourceType: 'linear', idempotencyKey: 'b', targetRepo: 'r', branch: 'br-1' }, seq());
  assert.equal((await getActiveAgentRunByBranch(db, 'p1', 'br-1'))?.id, run.id); // queued -> active
  await updateAgentRun(db, { id: run.id, status: 'completed' }, seq());
  assert.equal(await getActiveAgentRunByBranch(db, 'p1', 'br-1'), null);          // completed -> not active
});

test('createAgentRun persists an explicit branch when given', async () => {
  const db = new FakeD1();
  const { run } = await createAgentRun(
    db,
    { projectId: 'p1', sourceType: 'linear', idempotencyKey: 'k-branch', targetRepo: 'https://github.com/o/r', branch: 'morehands/eng-1' },
    seq(),
  );
  assert.equal(run.branch, 'morehands/eng-1');
});

test('updateAgentRun round-trips triggerRunId', async () => {
  const db = new FakeD1();
  const deps = seq();
  const { run } = await createAgentRun(db, { projectId: 'p1', sourceType: 'linear', idempotencyKey: 'k-trigger', targetRepo: 'r' }, deps);
  await updateAgentRun(db, { id: run.id, triggerRunId: 'run_abc' }, deps);
  const readBack = await getAgentRunById(db, run.id);
  assert.equal(readBack?.triggerRunId, 'run_abc');
});


// ---------------------------------------------------------------------------
// dispatchConcurrencyKey (per-issue serialization)
// ---------------------------------------------------------------------------

test('dispatchConcurrencyKey: initial run keys on project + issue identifier', () => {
  assert.equal(
    dispatchConcurrencyKey({ projectId: 'p1', runId: 'r1', targetBranch: null, issue: { id: 'x', identifier: 'FRD-12', url: '', title: 't', description: null } }),
    'p1:FRD-12',
  );
});

test('dispatchConcurrencyKey: delivery continuation lands on the same key as its initial run', () => {
  const initial = dispatchConcurrencyKey({ projectId: 'p1', runId: 'r1', targetBranch: null, issue: { id: 'x', identifier: 'FRD-12', url: '', title: 't', description: null } });
  const continuation = dispatchConcurrencyKey({ projectId: 'p1', runId: 'r2', targetBranch: 'harness/FRD-12', issue: null });
  assert.equal(continuation, initial);
});

test('dispatchConcurrencyKey: no issue identity falls back to runId (unique key, no serialization)', () => {
  assert.equal(dispatchConcurrencyKey({ projectId: 'p1', runId: 'r9', targetBranch: null, issue: null }), 'p1:r9');
});

test('dispatchConcurrencyKey: same identifier in different projects never collides', () => {
  const a = dispatchConcurrencyKey({ projectId: 'p1', runId: 'r1', targetBranch: null, issue: { id: 'x', identifier: 'FRD-12', url: '', title: 't', description: null } });
  const b = dispatchConcurrencyKey({ projectId: 'p2', runId: 'r2', targetBranch: null, issue: { id: 'x', identifier: 'FRD-12', url: '', title: 't', description: null } });
  assert.notEqual(a, b);
});

// ── assign_coding_run (the assigner dispatch tool) ──────────────────────────────────────────────

const activeRoute = (over: Row = {}): Row => ({
  id: 'route-1', project_id: 'P', provider: 'linear', external_key: 'EDK', trigger_type: 'state',
  trigger_value: 'Run Agent', github_owner: 'acme', github_repo: 'api', base_branch: 'main',
  kit: 'coding-default', runtime: 'pi', sandbox_provider: 'e2b', priority: 0, status: 'active',
  created_by_type: 'admin', created_by: 'admin-1', reason: 'r', created_at: 1, updated_at: 1,
  activated_by: 'admin-1', activated_at: 1, disabled_by: null, disabled_at: null, ...over,
});
const execAssign = (db: FakeD1, input: Record<string, unknown>, nowMs = 1_750_000_000_000) =>
  invokeTool(assignCodingRunTool({ db, projectId: 'P', now: () => nowMs }), input);

test('assign_coding_run: refuses without an active route (no standing grant, no row written)', async () => {
  const db = new FakeD1();
  const out = await execAssign(db, { title: 'Fix slugify', description: 'AC: x' });
  assert.match(out, /No active agent-run route/i);
  assert.equal(db.agentRuns.length, 0);
});

test('assign_coding_run: queues a run on the route grant, and the stored payload survives the runner contract', async () => {
  const db = new FakeD1();
  db.routes.push(activeRoute());
  const out = JSON.parse(await execAssign(db, {
    title: 'Strip trailing hyphens in slugify',
    description: 'AC:\n- slugify("!!!") === ""\nVerification: bun test',
    identifier: 'FRD-9',
    linearUrl: 'https://linear.app/x/issue/FRD-9',
  }));
  assert.equal(out.issueKey, 'FRD-9');
  assert.equal(out.branch, 'harness/FRD-9');
  assert.equal(out.kit, 'coding-default');
  assert.equal(out.status, 'queued');
  assert.equal(db.agentRuns.length, 1);
  const row = db.agentRuns[0];
  assert.equal(row.source_type, 'slack');
  assert.equal(row.route_id, 'route-1');
  // Producer↔contract assertion: the row dispatches through the SAME mapper the cron uses.
  const run = (await getAgentRunById(db, String(row.id)))!;
  const dispatch = buildRunnerDispatch(run, { githubToken: 'tok', runnerToken: 'rt', moreHandsPublicUrl: 'https://h.dev' });
  assert.equal(dispatch.kit, 'coding-default');
  assert.equal(dispatch.issue?.identifier, 'FRD-9');
  assert.match(dispatch.issue?.description ?? '', /bun test/);
  assert.equal(dispatchConcurrencyKey(dispatch), 'P:FRD-9', 'serializes with any Linear-triggered run for the same issue');
});

test('assign_coding_run: one live run per issue key — refuse while in flight, allow after terminal', async () => {
  const db = new FakeD1();
  db.routes.push(activeRoute());
  await execAssign(db, { title: 'T', description: 'D', identifier: 'FRD-9' }, 1000);
  const second = await execAssign(db, { title: 'T', description: 'D', identifier: 'FRD-9' }, 2000);
  assert.match(second, /already has a run in flight/i);
  assert.equal(db.agentRuns.length, 1);
  db.agentRuns[0].status = 'completed';
  const third = JSON.parse(await execAssign(db, { title: 'T again', description: 'D', identifier: 'FRD-9' }, 3000));
  assert.equal(third.status, 'queued');
  assert.equal(db.agentRuns.length, 2, 're-assign after terminal is a fresh run (same deterministic branch resumes the ledger)');
});

test('assign_coding_run: ad-hoc work gets a generated branch-safe identifier', async () => {
  const db = new FakeD1();
  db.routes.push(activeRoute());
  const out = JSON.parse(await execAssign(db, { title: 'Tidy the README badges!', description: 'D' }));
  assert.match(out.issueKey, /^A-tidy-the-readme-badges-[a-z0-9]+$/);
  assert.equal(out.branch, `harness/${out.issueKey}`);
  assert.equal(adHocIdentifier('!!!', 99), `A-task-${(99).toString(36).slice(-4)}`, 'all-punctuation titles fall back to "task"');
});

// ── check_agent_runs (the run-status visibility tool) ───────────────────────────────────────────

const execCheck = (db: FakeD1, input: Record<string, unknown>, nowMs = 1_750_000_000_000) =>
  invokeTool(checkAgentRunsTool({ db, projectId: 'P', now: () => nowMs }), input);

test('check_agent_runs: lists recent runs newest first with receipts, never the dispatch payload', async () => {
  const db = new FakeD1();
  db.routes.push(activeRoute());
  await execAssign(db, { title: 'First', description: 'D' }, 1000);
  await execAssign(db, { title: 'Second', description: 'D', identifier: 'FRD-2' }, 2000);
  db.agentRuns[0].created_at = 1000; // createAgentRun stamps wall-clock time; pin the order
  db.agentRuns[1].created_at = 2000;
  db.agentRuns[1].status = 'running';
  db.agentRuns[1].pr_url = 'https://github.com/acme/api/pull/7';
  db.agentRuns[1].last_heartbeat_at = 2000;

  const out = await execCheck(db, {}, 2000 + 5 * 60_000);
  const runs = JSON.parse(out) as Array<Record<string, unknown>>;
  assert.equal(runs.length, 2);
  assert.equal(runs[0].issueKey, 'FRD-2', 'newest first');
  assert.equal(runs[0].status, 'running');
  assert.equal(runs[0].prUrl, 'https://github.com/acme/api/pull/7');
  assert.equal(runs[0].minutesSinceHeartbeat, 5);
  assert.equal(runs[1].minutesSinceHeartbeat, null, 'no heartbeat yet → null, not 0');
  assert.doesNotMatch(out, /dispatchPayload|idempotency|sandbox_id/i, 'model-safe projection only');
});

test('check_agent_runs: issueKey matches the tracker identifier even when linear_issue_id is a UUID', async () => {
  const db = new FakeD1();
  db.routes.push(activeRoute());
  await execAssign(db, { title: 'T', description: 'D', identifier: 'WID-71' }, 1000);
  // Webhook-created runs keep the Linear UUID in linear_issue_id and the key in linear_identifier.
  db.agentRuns[0].linear_issue_id = 'uuid-123';

  const single = JSON.parse(await execCheck(db, { issueKey: 'WID-71' })) as Record<string, unknown>;
  assert.equal(single.issueKey, 'WID-71');
  assert.match(await execCheck(db, { issueKey: 'WID-99' }), /No runs for "WID-99"/);
});

test('check_agent_runs: empty project reports plainly and clamps the limit', async () => {
  const db = new FakeD1();
  assert.match(await execCheck(db, {}), /No agent runs/);
  db.routes.push(activeRoute());
  for (let i = 0; i < 12; i++) await execAssign(db, { title: `T${i}`, description: 'D', identifier: `FRD-${i}` }, 1000 + i);
  assert.equal((JSON.parse(await execCheck(db, { limit: 50 })) as unknown[]).length, 10, 'limit clamps to 10');
});

await run();
