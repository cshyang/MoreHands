// Transactional-outbox dispatch + reconciler for agent runs.
//
// The agent_runs row IS the durable ticket. Two callers drive it through the same primitives here:
//   1. The Linear webhook — immediate best-effort dispatch (via waitUntil), so a healthy run starts now.
//   2. The ticker reconciler — the durability backstop: it (re)dispatches queued runs, reclaims runs
//      stuck mid-dispatch (a dispatcher that claimed then died), and times out runs whose runner went
//      dark. Flue's generated entry drops scheduled(), so the cron lives on the external ticker worker.
//
// The claim (queued -> dispatching) is an atomic compare-and-set (repository.claimRunForDispatch), so
// the immediate path and a reconciler tick can race safely — only one wins and dispatches.
//
// RUNNER CONTRACT (external assumptions this code can't enforce — keep the runner honest):
//   1. Dispatch is IDEMPOTENT on runId. A run stuck in `dispatching` (the ->running write failed after
//      Trigger accepted) is reclaimed at the lease and re-dispatched, so Trigger may receive the same
//      runId twice. We pass it as the Trigger idempotencyKey so the second trigger returns the existing
//      run instead of starting a second job.
//   2. The runner emits callbacks (any status) as it works. Each bumps last_heartbeat_at; a runner that
//      goes silent past RUNNING_STALE_MS is presumed dead and failed. No callbacks → coarse liveness only.

import * as v from 'valibot';
import { fetchWithTimeout, jsonMessageOrText } from '../providers/http';
import type { D1Like } from '../skills/repository';
import { RUNNER_CONTRACT_VERSION, RunnerDispatchSchema, type RunnerDispatch } from './runner-contract';
import { createAgentRunChannelNotifications } from './events';
import { reserveIngressBudget, reserveIngressBudgetShare } from '../slack/ingress-budget';
import {
  claimRunForDispatch,
  failStaleRunningRun,
  listDispatchableRuns,
  listStaleDispatchingRuns,
  listStaleRunningRuns,
  requeueStaleDispatchingRun,
  updateAgentRun,
  type AgentRun,
  type ClockAndIds,
} from './repository';

export const DISPATCH_MAX_ATTEMPTS = 5; // after this many failed starts, the run is terminally failed
export const DISPATCH_LEASE_MS = 90_000; // a `dispatching` row older than this is a crashed dispatcher → reclaim
// Coarse liveness, NOT a tight heartbeat. Every runner callback bumps last_heartbeat_at, but a long
// coding stretch can run for an hour+ with no intermediate callback, so this window must comfortably
// exceed the longest plausible silent run. For tighter detection the runner must emit periodic
// heartbeat callbacks (any callback counts). Tune down once it does.
export const RUNNING_STALE_MS = 3 * 60 * 60_000; // 3h silent → presumed dead
export const RECONCILE_DISPATCH_LIMIT = 10; // queued runs dispatched per tick (bounds work)
export const RECONCILE_SWEEP_LIMIT = 50; // stale rows reclaimed/timed-out per tick
const RUNNER_FETCH_TIMEOUT_MS = 12_000;

export interface RunnerDispatchDeps {
  triggerApiUrl?: string; // Trigger.dev REST base URL (e.g. https://api.trigger.dev)
  triggerSecretKey?: string; // Trigger.dev secret key (Bearer)
  githubToken?: string; // short-lived, repo-scoped token handed to the coding task (transition fallback)
  /** Per-run, freshly-minted GitHub token (App installation token via the connection broker). Preferred
   *  over the static githubToken — resolved on every dispatch attempt, so retries/continuations get a
   *  fresh token. githubToken stays as the transition fallback (RUNNER_GITHUB_PAT_TEMP). */
  resolveGithubToken?: (run: AgentRun, db?: D1Like) => Promise<string | null>;
  runnerToken?: string; // callback auth: the runner echoes this on its callbacks
  moreHandsPublicUrl?: string; // absolute origin Trigger calls back to (REQUIRED — callback is external)
  fetch?: typeof fetch;
}

export interface DispatchResult {
  dispatched: boolean;
  status: AgentRun['status'] | 'skipped';
  reason?: string;
}

// A runner failure that knows whether retrying could help. 5xx/429/timeout/network = transient (requeue);
// 4xx = the request itself is wrong (terminal).
class RunnerDispatchError extends Error {
  retryable: boolean;
  constructor(message: string, opts: { retryable: boolean }) {
    super(message);
    this.name = 'RunnerDispatchError';
    this.retryable = opts.retryable;
  }
}

function runnerCallbackUrl(moreHandsPublicUrl: string | undefined): string | undefined {
  if (!moreHandsPublicUrl) return undefined;
  return `${moreHandsPublicUrl.replace(/\/+$/, '')}/__internal/agent-runs`;
}

// Map the self-contained stored row into the runner CONTRACT object. The stored dispatchPayload is the
// outbox message shaped at create time; it does NOT match the contract, so we map field-by-field here.
// runId/projectId/callback are injected at send time (runId isn't known until the row exists; the
// callback URL is env-derived so a stored copy could go stale). The final v.parse is the producer↔contract
// assertion: a payload that can't satisfy the schema (e.g. a legacy `runtime: 'opencode'`) is FATAL —
// retrying can't fix a malformed payload, so we mark it non-retryable.
export function buildRunnerDispatch(run: AgentRun, deps: RunnerDispatchDeps): RunnerDispatch {
  const stored = run.dispatchPayload ? (JSON.parse(run.dispatchPayload) as Record<string, unknown>) : {};
  const mode = stored.mode === 'continuation' ? 'continuation' : 'initial';
  const snapshot = stored.linearIssue as Record<string, unknown> | undefined;
  const issue =
    mode === 'initial' && snapshot
      ? {
          id: snapshot.id,
          identifier: snapshot.identifier,
          url: snapshot.url,
          title: snapshot.title,
          description: snapshot.description ?? null,
        }
      : null;
  const obj = {
    contractVersion: RUNNER_CONTRACT_VERSION,
    runId: run.id,
    projectId: run.projectId,
    mode,
    targetRepo: stored.targetRepo,
    baseBranch: stored.baseBranch,
    targetBranch: stored.targetBranch ?? null,
    kit: stored.kit,
    runtime: stored.runtime,
    sandboxProvider: stored.sandboxProvider,
    issue,
    feedback: stored.feedback ?? null,
    prUrl: stored.prUrl ?? null,
    replyTarget: stored.replyTarget ?? null,
    githubToken: deps.githubToken,
    callback: { url: runnerCallbackUrl(deps.moreHandsPublicUrl), token: deps.runnerToken },
  };
  try {
    return v.parse(RunnerDispatchSchema, obj);
  } catch (e) {
    // A malformed payload can't be fixed by retrying — fail it terminally rather than requeue forever.
    const message = e instanceof v.ValiError ? `invalid runner dispatch: ${e.message}` : 'invalid runner dispatch';
    throw new RunnerDispatchError(message, { retryable: false });
  }
}

/** Pick the GitHub token for a dispatch: the per-run connection token (App installation token via the
 *  broker), else the transition PAT. Resolved fresh on every attempt — the token is never persisted. */
export async function resolveDispatchGithubToken(run: AgentRun, deps: RunnerDispatchDeps, db?: D1Like): Promise<string | null> {
  return (await deps.resolveGithubToken?.(run, db)) ?? deps.githubToken ?? null;
}

/**
 * Per-issue serialization key. Two dispatches for the same issue must never run concurrently —
 * for the harness kit both would commit to the same deterministic `harness/<id>` branch; for
 * coding-default a continuation pushes a specific PR branch. The task's queue has
 * `concurrencyLimit: 1`, and Trigger creates a separate one-slot queue per distinct key, so
 * different issues still run in parallel.
 *
 * Key resolution: issue identifier when known (initial runs) → targetBranch with the delivery
 * `harness/` prefix stripped (continuations of the same issue land on the same key as their
 * initial run) → runId (no issue identity at all: unique key, effectively unserialized).
 * Project-scoped so identical identifiers in different projects never collide.
 */
export function dispatchConcurrencyKey(d: Pick<RunnerDispatch, 'projectId' | 'issue' | 'targetBranch' | 'runId'>): string {
  const issueKey = d.issue?.identifier ?? d.targetBranch?.replace(/^harness\//, '') ?? d.runId;
  return `${d.projectId}:${issueKey}`;
}

async function triggerCodingTask(deps: RunnerDispatchDeps, dispatch: RunnerDispatch): Promise<{ triggerRunId: string }> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${deps.triggerApiUrl!.replace(/\/+$/, '')}/api/v1/tasks/run-coding-task/trigger`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${deps.triggerSecretKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          payload: dispatch,
          options: { idempotencyKey: dispatch.runId, concurrencyKey: dispatchConcurrencyKey(dispatch) },
        }),
      },
      {
        timeoutMs: RUNNER_FETCH_TIMEOUT_MS,
        timeoutMessage: `trigger dispatch timed out after ${RUNNER_FETCH_TIMEOUT_MS}ms`,
        failurePrefix: 'trigger dispatch failed',
        fetchImpl: deps.fetch,
      },
    );
  } catch (e) {
    // timeout / network — retrying may well succeed
    throw new RunnerDispatchError(e instanceof Error ? e.message : 'trigger dispatch failed', { retryable: true });
  }
  const textBody = await res.text();
  if (!res.ok) {
    const retryable = res.status >= 500 || res.status === 429; // 5xx/429 retry; 4xx fatal
    throw new RunnerDispatchError(`trigger ${res.status}: ${jsonMessageOrText(textBody, 160)}`, { retryable });
  }
  let parsed: { id?: unknown };
  try {
    parsed = JSON.parse(textBody) as { id?: unknown };
  } catch {
    // A 2xx with a non-JSON body is a malformed response, not a transient fault — fatal, don't requeue.
    throw new RunnerDispatchError('trigger response was not JSON', { retryable: false });
  }
  if (typeof parsed.id !== 'string') throw new RunnerDispatchError('trigger response missing run id', { retryable: false });
  return { triggerRunId: parsed.id }; // Trigger REST response run id is top-level `id`
}

// Send a CLAIMED run (already in `dispatching`) to the Trigger.dev coding task and record the outcome:
//   success            -> running (+ trigger run id)
//   transient failure  -> requeue, until attempts hit the cap, then fail
//   permanent failure  -> failed
async function dispatchClaimedRun(
  db: D1Like,
  run: AgentRun,
  deps: RunnerDispatchDeps,
  clock: ClockAndIds,
): Promise<DispatchResult> {
  try {
    // Resolve the GitHub token here (post-claim → only the claim winner pays the Nango round-trip; not
    // persisted, so each attempt mints fresh). buildRunnerDispatch stays a sync pure mapping — we just
    // override its githubToken with the resolved one.
    const githubToken = await resolveDispatchGithubToken(run, deps, db);
    if (!githubToken) {
      // No connection token and no PAT. Retryable so it self-heals once the project connects a GitHub
      // App; the attempt cap eventually fails it with this clear reason instead of queuing forever.
      throw new RunnerDispatchError(`no github credential for project ${run.projectId}`, { retryable: true });
    }
    const { triggerRunId } = await triggerCodingTask(deps, buildRunnerDispatch(run, { ...deps, githubToken }));
    await updateAgentRun(db, { id: run.id, status: 'running', triggerRunId }, clock);
    return { dispatched: true, status: 'running' };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'trigger dispatch failed';
    const retryable = e instanceof RunnerDispatchError ? e.retryable : true;
    const overCap = run.dispatchAttempts >= DISPATCH_MAX_ATTEMPTS;
    if (!retryable || overCap) {
      const reason = overCap
        ? `dispatch failed after ${run.dispatchAttempts} attempts: ${message}`
        : message;
      await updateAgentRun(db, { id: run.id, status: 'failed', error: reason, lastDispatchError: message }, clock);
      return { dispatched: false, status: 'failed', reason: message };
    }
    await updateAgentRun(db, { id: run.id, status: 'queued', lastDispatchError: message }, clock);
    return { dispatched: false, status: 'queued', reason: message };
  }
}

/**
 * Claim a queued run and dispatch it. Safe to call from the webhook (immediate) AND the reconciler:
 * the atomic claim guarantees only one wins. Leaves the run queued (for the ticker to retry) when the
 * runner isn't configured, so a transient deploy-time config gap self-heals instead of killing the run.
 */
export async function claimAndDispatchRun(
  db: D1Like,
  runId: string,
  deps: RunnerDispatchDeps,
  clock: ClockAndIds = {},
): Promise<DispatchResult> {
  if (!deps.triggerApiUrl || !deps.triggerSecretKey || !deps.runnerToken || !(deps.githubToken || deps.resolveGithubToken) || !deps.moreHandsPublicUrl) {
    return { dispatched: false, status: 'skipped', reason: 'trigger dispatch not fully configured' };
  }
  const claimed = await claimRunForDispatch(db, runId, clock);
  if (!claimed) return { dispatched: false, status: 'skipped', reason: 'run was not claimable (already dispatching/terminal)' };
  return dispatchClaimedRun(db, claimed, deps, clock);
}

export interface ReconcileSummary {
  reclaimed: number; // stuck `dispatching` returned to queued
  timedOut: number; // `running` past the heartbeat window, failed
  dispatched: number; // queued runs started this tick
  failed: number; // queued runs over the attempt cap, failed
  skipped: number; // claim lost / not configured
}

/**
 * One reconcile pass. Order matters: reclaim stuck dispatching → queued FIRST so the dispatch step
 * below picks them up in the same tick; time out dead runners; then dispatch the queued backlog.
 */
export async function reconcileAgentRuns(
  db: D1Like,
  deps: RunnerDispatchDeps,
  clock: ClockAndIds = {},
): Promise<ReconcileSummary> {
  const now = clock.now?.() ?? Date.now();
  const summary: ReconcileSummary = { reclaimed: 0, timedOut: 0, dispatched: 0, failed: 0, skipped: 0 };

  // Per-record maxima include primary readbacks; scopes are reserved before any mutation.
  const reclaim = reserveIngressBudgetShare(db, 3);
  if (reclaim) try {
    for (const run of await listStaleDispatchingRuns(reclaim.db, now - DISPATCH_LEASE_MS, RECONCILE_SWEEP_LIMIT)) {
      const operation = reserveIngressBudget(reclaim.db, 2);
      if (!operation) break;
      try { if (await requeueStaleDispatchingRun(operation.db, run.id, now - DISPATCH_LEASE_MS, clock)) summary.reclaimed++; }
      finally { operation.release(); }
    }
  } finally { reclaim.release(); }

  const timeout = reserveIngressBudgetShare(db, 2);
  if (timeout) try {
    for (const run of await listStaleRunningRuns(timeout.db, now - RUNNING_STALE_MS, RECONCILE_SWEEP_LIMIT)) {
      const operation = reserveIngressBudget(timeout.db, 8); // UPDATE/readback + two notification insert/readbacks
      if (!operation) break;
      try {
        const failed = await failStaleRunningRun(operation.db, run.id, now - RUNNING_STALE_MS, clock);
        if (!failed) continue;
        await createAgentRunChannelNotifications(operation.db, { projectId: failed.projectId, runId: failed.id,
          notificationType: 'failed', linearTargetRef: failed.linearIssueId ?? failed.linearIdentifier ?? null }, clock).catch(() => {});
        summary.timedOut++;
      } finally { operation.release(); }
    }
  } finally { timeout.release(); }

  const dispatches = reserveIngressBudgetShare(db, 1);
  if (dispatches) try {
    const jobs: Promise<'dispatched' | 'failed' | 'skipped'>[] = [];
    for (const run of await listDispatchableRuns(dispatches.db, RECONCILE_DISPATCH_LIMIT)) {
      // Acquire synchronously before launching parallel work; one run cannot borrow another's slots.
      const operation = reserveIngressBudget(dispatches.db, run.dispatchAttempts >= DISPATCH_MAX_ATTEMPTS ? 3 : 10);
      if (!operation) break;
      jobs.push((async () => {
        try {
          if (run.dispatchAttempts >= DISPATCH_MAX_ATTEMPTS) {
            await updateAgentRun(operation.db, { id: run.id, status: 'failed',
              error: `dispatch failed after ${run.dispatchAttempts} attempts`,
              lastDispatchError: run.lastDispatchError ?? 'attempt cap reached' }, clock);
            return 'failed' as const;
          }
          const result = await claimAndDispatchRun(operation.db, run.id, deps, clock);
          return result.dispatched ? 'dispatched' as const : result.status === 'failed' ? 'failed' as const : 'skipped' as const;
        } finally { operation.release(); }
      })());
    }
    const outcomes = await Promise.allSettled(jobs);
    for (const outcome of outcomes) if (outcome.status === 'fulfilled') summary[outcome.value]++;
    const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failed) throw failed.reason;
  } finally { dispatches.release(); }
  return summary;
}
