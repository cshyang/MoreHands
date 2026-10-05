import { Hono } from 'hono';
import { acceptSlackIngress, requireIngressDb } from './slack/ingress-store';
import { withIngressBudget, remainingIngressBudget, reserveIngressBudget, reserveIngressBudgetShare, type QueryReservation } from './slack/ingress-budget';
import { recoverSlackIngress } from './gateway/slack-ingress';
import { observe } from '@flue/runtime';
import { dispatchProject } from './gateway/dispatch';
import { verifySlackSignature } from './slack/verify';
import { handleObservedSlackActivity } from './slack/activity';
import { parseSlashCommandPayload, runSlashCommand } from './slack/commands';
import {
  parseSlackEventEnvelope,
  slackUrlVerification,
  slackUserMessageEvent,
  verifiedIngressEvent,
} from './slack/events';
import { bindingBySlack, bindingByProject, agentInstanceId } from './project/bindings';
import { bumpAgentEpoch } from './project/conversations';
import { claimEvent, type KVLike } from './shared/idempotency';
import type { D1Like } from './skills/repository';
import { projectsWithUnreflected, projectsWithUnreflectedRuns, takeUnreflectedBatch, takeUnreflectedRuns, buildReflectInstructions } from './knowledge/reflection';
import {
  projectsToReview,
  takeReviewBatch,
  buildReviewInstructions,
  loadReviewState,
  answerBudgetFree,
} from './review';
import { upsertConnection, loadConnections, connectedNotice, disconnectedNotice, disableConnectionByRef } from './connections/repository';
import { verifyNangoWebhook, parseNangoAuthWebhook, parseNangoDeletionWebhook, fetchProviderApiSpec } from './providers/nango';
import { isCatalogProvider } from './connections/catalog';
import { handleScheduledJob } from './gateway/scheduled-dispatch';
import { hasMatchingSecretHeader } from './gateway/auth';
import { readJsonOrNull } from './gateway/json';
import { reconcileReplies, reconcileNativeReplies, type ReplyAgentNamespace } from './gateway/replies';
import { postConnectionNotice } from './connections/notices';
import { handleInternalWorkItemRequest } from './workbench/gateway';
import { handleSourceChangeRunCallback } from './workbench/source-change';
import { handleLinearComment, handleLinearWebhook, verifyLinearWebhook } from './agent-runs/linear';
import { AdmissionUnavailable, beginIntake, beginDrain } from './cutover/admissions';
import { createProducerScope, type ProducerScope } from './cutover/producer';
import { deriveInstanceIdentities, observeAssociatedInstance, readCutoverStatus, changeCutoverAdmissions } from './cutover/diagnostics';
import { handleAgentRunCallback, type AgentRun } from './agent-runs/repository';
import { moveLinearIssueState, postLinearComment, replyTextForCallback } from './agent-runs/linear-reply';
import { reconcileAgentRuns } from './agent-runs/dispatch';
import { resolveProviderToken } from './connections/repository';
import { activateAgentRunRoute, disableAgentRunRoute } from './agent-runs/events';
import { handleNangoForwardWebhook } from './agent-runs/provider-events';
import { deliverPendingSlackRunNotifications } from './agent-runs/notifications';
import { listCodeExecutionAudits } from './code-mode/code-mode';

// Application-owned ingress verifies and routes product events before native dispatch.
// The Project agent has no public transport: Slack and internal token guards own admission.

interface Env {
  SLACK_SIGNING_SECRET?: string;
  SLACK_EVENTS?: KVLike; // KV namespace for event_id idempotency
  HEARTBEAT_TOKEN?: string; // shared secret guarding internal scheduler/reconciliation routes
  WORKBENCH_RUNNER_TOKEN?: string; // dedicated secret for source-change runner callbacks
  CODING_RUNNER_URL?: string; // generic source-change runner dispatch endpoint
  LINEAR_WEBHOOK_SECRET?: string; // Linear raw-body HMAC signing secret for /linear/webhook
  LINEAR_AGENT_PROJECTS?: string; // legacy one-release fallback; prefer agent_run_routes
  LINEAR_PR_OPENED_STATE?: string; // workflow state to move the issue to on PR-opened (default "In Review"); needs Linear write scope
  LINEAR_API_KEY?: string; // reserved for gateway-owned Linear status comments; never exposed to the model
  AGENT_RUNNER_URL?: string; // legacy generic runner dispatch endpoint; superseded by Trigger.dev
  AGENT_RUNNER_TOKEN?: string; // dedicated secret for agent-run callbacks
  MOREHANDS_PUBLIC_URL?: string; // absolute origin Trigger.dev calls back to (REQUIRED for coding dispatch)
  TRIGGER_SECRET_KEY?: string; // Trigger.dev secret key (Bearer) for the coding-task dispatch
  TRIGGER_API_URL?: string; // Trigger.dev REST base URL; defaults to https://api.trigger.dev
  RUNNER_GITHUB_PAT_TEMP?: string; // temporary GitHub PAT handed to the coding task (M0a stopgap; short-lived tokens later)
  LINEAR_BOT_ACTOR_ID?: string; // MoreHands's own Linear actor id; its transitions never self-trigger a run
  ADMIN_CONNECTIONS_TOKEN?: string; // OWN secret guarding /__admin/connections (ADR D11 — NOT the heartbeat token)
  NANGO_SECRET_KEY?: string; // platform Bearer for the Nango API (create session / fetch token)
  NANGO_WEBHOOK_SECRET?: string; // HMAC signing key to verify inbound Nango auth webhooks
  NANGO_INTEGRATION_KEYS?: string; // optional JSON mapping provider/authMode to Nango integration keys
  DYNAMIC_WORKER_LOADER?: unknown; // Cloudflare Worker Loader binding for coordinator execute_code
  CODE_EXEC_MAX_CODE_BYTES?: string;
  CODE_EXEC_MAX_INPUT_BYTES?: string;
  CODE_EXEC_MAX_OUTPUT_BYTES?: string;
  CODE_EXEC_CPU_MS?: string;
  CODE_EXEC_SUBREQUESTS?: string;
  DB?: D1Like; // D1 skill catalog, transcript, memory, and conversation targets
  FLUE_PROJECT_AGENT?: ReplyAgentNamespace;
  CUTOVER_NAMESPACE_ID?: string;
  ZAI_API_KEY?: string; // canonical key for the native Z.ai provider
  ZAI_CODING_API_KEY?: string; // legacy deployment alias, normalized by src/agent/providers.ts
  [binding: string]: unknown;
}

observe((event, ctx) => {
  void handleObservedSlackActivity(event, ctx);
});

// Workspace-level transport identity for gateway auto-provisioning (same-workspace Milestone 1:
// one bot install, reused across all channels of the known team) is account-coupled config, resolved
// from env per request via deploymentConfig(c.env) — see src/config/deployment.ts. Falls back to the
// original Ecodark literals when unset, so an existing deployment is unchanged.

const app = new Hono<{ Bindings: Env }>();

function requireHeartbeat(c: { env: Env; req: { header(n: string): string | undefined } }): boolean {
  return hasMatchingSecretHeader(c.env.HEARTBEAT_TOKEN, c.req.header('x-morehands-token'));
}

// Lost native wakes must not strand durable capture, Slack delivery or receipt repair.
app.post('/__internal/replies/reconcile', async (c) => {
  if (!requireHeartbeat(c)) return c.body(null, 404);
  if (!c.env.DB) return c.json({ reconciled: false, reason: 'no DB binding' });
  const env = withIngressBudget(c.env);
  if (remainingIngressBudget(env.DB!) < 8) return c.json({ deferred: true });
  const summary = await reconcileReplies(env.DB!, env, {
    reconcileInstance: (id) => reconcileNativeReplies(c.env.FLUE_PROJECT_AGENT, id),
  });
  return c.json(summary);
});

// Per-job fire from the minutely reminder scan (the agent's self-scheduled work,
// stored in the D1 reminders table). This targets ONE project, in an instance scope dedicated
// to the job id so each named schedule keeps its own memory. `fireId` makes it idempotent
// against scan retries via the same KV claim layer.
app.post('/__internal/scheduled', async (c) => {
  if (!requireHeartbeat(c)) return c.body(null, 404);

  const body = await readJsonOrNull<{
    fireId?: string;
    projectId?: string;
    jobId?: string;
    kind?: string;
    payload?: Record<string, unknown>;
  }>(() => c.req.json());
  if (!body?.fireId || !body.projectId || !body.jobId) return c.json({ error: 'bad request' }, 400);

  let scope: ProducerScope;
  try { scope = createProducerScope(c.env, await beginIntake(c.env, 'g2', 'scheduled')); }
  catch (error) {
    if (error instanceof AdmissionUnavailable) return c.json({ error: 'admissions unavailable' }, 503);
    throw error;
  }
  let succeeded = false;
  try {
    const result = await handleScheduledJob(c.env, body);
    succeeded = result.status < 400;
    return c.json(result.body, result.status as 200 | 400);
  } finally { c.executionCtx.waitUntil(scope.finish(succeeded)); }
});

// Internal workbench intake. Future Linear/Slack/manual adapters call this to create a durable
// work item. Dispatch is tracked on a work_run because Flue dispatch is an external side effect,
// not part of the D1 write.
app.post('/__internal/work-items', async (c) => {
  if (!requireHeartbeat(c)) return c.body(null, 404);
  let scope: ProducerScope;
  try { scope = createProducerScope(c.env, await beginIntake(c.env, 'g2', 'work-item')); }
  catch (error) {
    if (error instanceof AdmissionUnavailable) return c.json({ error: 'admissions unavailable' }, 503);
    throw error;
  }
  let succeeded = false;
  try {
    const result = await handleInternalWorkItemRequest(
      {
        db: c.env.DB,
        expectedToken: c.env.HEARTBEAT_TOKEN,
        actualToken: c.req.header('x-morehands-token'),
        body: await readJsonOrNull(() => c.req.json()),
      },
      { bindingByProject, dispatch: (request) => dispatchProject(c.env, request) },
    );
    succeeded = result.status < 400 && result.body?.dispatchStatus !== 'failed';
    if (result.status === 404) return c.body(null, 404);
    return c.json(result.body ?? {}, result.status as 200 | 400 | 500);
  } finally { c.executionCtx.waitUntil(scope.finish(succeeded)); }
});

// Generic coding-runner callback. The runner edits code and opens PRs elsewhere; this route only
// records branch/PR/CI/deploy metadata back into the workbench. Dedicated token on purpose: runner
// reporting is not scheduler/heartbeat authority.
app.post('/__internal/source-change-runs', async (c) => {
  const result = await handleSourceChangeRunCallback(
    {
      db: c.env.DB,
      expectedToken: c.env.WORKBENCH_RUNNER_TOKEN,
      actualToken: c.req.header('x-morehands-runner-token'),
      body: await readJsonOrNull(() => c.req.json()),
    },
  );
  if (result.status === 404) return c.body(null, 404);
  return c.json(result.body ?? {}, result.status as 200 | 400 | 500);
});

// Per-run GitHub token for dispatch: resolve the run's project binding, then its 'github' connection
// (App installation token via the broker — see M0c plan). Preferred over RUNNER_GITHUB_PAT_TEMP; a null
// (no connection) falls back to the PAT in resolveDispatchGithubToken. Fresh per attempt (not persisted).
const makeGithubTokenResolver = (env: Env) => async (run: AgentRun): Promise<string | null> => {
  try {
    const binding = await bindingByProject(run.projectId, env.DB);
    if (!binding) return null;
    // `await` so a rejected Nango thunk (e.g. a stale/dead connectionRef) is caught here, not thrown
    // up into the dispatch. A broken connection must NOT fail the run — fall back to the transition
    // PAT (resolveDispatchGithubToken treats null as "use deps.githubToken").
    return await resolveProviderToken(env.DB, binding, env as unknown as Record<string, unknown>, 'github');
  } catch (e) {
    console.error('[agent-runs] github token resolution failed, falling back to PAT (best-effort):', e instanceof Error ? e.message : e);
    return null;
  }
};

// Linear is the team-facing baton for coding-agent work. The gateway verifies Linear's raw-body
// HMAC and turns only "Issue transitioned into Run Agent" into an agent_run lease. The external
// runner owns coding-agent/E2B/PR behavior; MoreHands only records dispatch and callback metadata.
app.post('/linear/webhook', async (c) => {
  const raw = await c.req.text();
  if (!(await verifyLinearWebhook(c.env.LINEAR_WEBHOOK_SECRET ?? '', raw, c.req.header('linear-signature')))) {
    return c.body(null, 404);
  }
  let scope: ProducerScope;
  try { scope = createProducerScope(c.env, await beginIntake(c.env, 'g2', 'linear')); }
  catch (error) {
    if (error instanceof AdmissionUnavailable) return c.json({ error: 'admissions unavailable' }, 503);
    throw error;
  }
  let succeeded = false;
  try {
    // Issue state-changes trigger NEW runs (handleLinearWebhook); comments on an issue with an existing
    // run/PR spawn CONTINUATION runs on that PR branch (handleLinearComment). Same signed ingress, same
    // deferred dispatch + reconciler backstop.
    const event = c.req.header('linear-event');
    const linearReq = {
      db: c.env.DB,
      signingSecret: c.env.LINEAR_WEBHOOK_SECRET,
      signature: c.req.header('linear-signature'),
      deliveryId: c.req.header('linear-delivery'),
      event,
      rawBody: raw,
      projectsJson: c.env.LINEAR_AGENT_PROJECTS,
      nowMs: Date.now(),
    };
    const linearDeps = {
      triggerApiUrl: c.env.TRIGGER_API_URL ?? 'https://api.trigger.dev',
      triggerSecretKey: c.env.TRIGGER_SECRET_KEY,
      githubToken: c.env.RUNNER_GITHUB_PAT_TEMP, // transition fallback; resolveGithubToken is preferred
      resolveGithubToken: makeGithubTokenResolver(c.env),
      runnerToken: c.env.AGENT_RUNNER_TOKEN,
      moreHandsPublicUrl: c.env.MOREHANDS_PUBLIC_URL,
      botActorId: c.env.LINEAR_BOT_ACTOR_ID,
      fetch,
    };
    const result =
      event === 'Comment'
        ? await handleLinearComment(linearReq, linearDeps)
        : await handleLinearWebhook(linearReq, linearDeps);
    // Immediate best-effort dispatch off the ack path; the ticker reconciler is the durable backstop.
    if (result.dispatch) {
      const dispatching = scope.track(result.dispatch().then(outcome => {
        // The runner handler records errors and resolves; that is not positive completion evidence.
        if (!(outcome as { dispatched?: boolean } | null)?.dispatched) throw new Error('producer dispatch incomplete');
      }));
      c.executionCtx.waitUntil(dispatching.catch(() => {}));
    }
    succeeded = result.status < 400;
    if (result.status === 404) return c.body(null, 404);
    return c.json(result.body ?? {}, result.status as 200 | 400 | 500);
  } finally { c.executionCtx.waitUntil(scope.finish(succeeded)); }
});

// Agent-run callback from the external E2B coding runner. Dedicated token: runner reporting
// does not grant heartbeat, connection-admin, merge, or deploy authority.
app.post('/__internal/agent-runs', async (c) => {
  const result = await handleAgentRunCallback({
    db: c.env.DB,
    expectedToken: c.env.AGENT_RUNNER_TOKEN,
    actualToken: c.req.header('x-morehands-agent-runner-token'),
    body: await readJsonOrNull(() => c.req.json()),
  });
  if (result.status === 404) return c.body(null, 404);

  // Best-effort Linear comment. A failure here must NEVER change the HTTP response or throw.
  if (result.reply) {
    const reply = result.reply;
    const text = replyTextForCallback(reply.type, reply);
    if (text) {
      // waitUntil (not a floating promise) so the Worker keeps the isolate alive until the post
      // finishes — a bare async IIFE can be cancelled when the response returns. Matches the
      // dispatch pattern above. Still best-effort: the inner try/catch swallows all failures.
      c.executionCtx.waitUntil((async () => {
        // Resolve the project's Linear token once, then run the comment and (on pr_opened) the
        // status move as INDEPENDENT best-effort writes: they need different scopes (comments:create
        // vs write), so a comment that works under comments:create must not be blocked by a status
        // move that needs write. A Linear failure never changes the HTTP response (already sent).
        let token: string;
        try {
          const projectId = result.body?.run?.projectId;
          if (!projectId) return;
          const binding = await bindingByProject(projectId, c.env.DB);
          if (!binding) return;
          const resolvedToken = await resolveProviderToken(c.env.DB, binding, c.env as Record<string, unknown>, 'linear');
          if (!resolvedToken) return;
          token = resolvedToken;
        } catch (e) {
          console.error('[agent-runs] Linear token resolution failed (best-effort):', e instanceof Error ? e.message : e);
          return;
        }
        try {
          await postLinearComment({ issueId: reply.issueId, body: text, token, fetchImpl: fetch });
        } catch (e) {
          console.error('[agent-runs] Linear comment post failed (best-effort):', e instanceof Error ? e.message : e);
        }
        if (reply.type === 'pr_opened') {
          const stateName = (typeof c.env.LINEAR_PR_OPENED_STATE === 'string' && c.env.LINEAR_PR_OPENED_STATE.trim()) || 'In Review';
          try {
            await moveLinearIssueState({ issueId: reply.issueId, stateName, token, fetchImpl: fetch });
          } catch (e) {
            console.error('[agent-runs] Linear status move failed (best-effort):', e instanceof Error ? e.message : e);
          }
        }
      })());
    }
  }

  return c.json(result.body ?? {}, result.status as 200 | 400 | 500);
});

// Agent-run reconciler. The every-2-min cron in .flue/cloudflare.ts pokes this in-process.
// It (re)dispatches queued runs, reclaims runs stuck mid-dispatch, and times out runs whose
// runner went dark — the durability backstop for the fire-and-forget webhook.
app.post('/__internal/agent-runs/reconcile', async (c) => {
  if (!requireHeartbeat(c)) return c.body(null, 404);
  const env = withIngressBudget(c.env), db = env.DB;
  if (db && remainingIngressBudget(db) < 13) return c.json({ deferred: true });
  const completion = db ? reserveIngressBudget(db, 1) : null;
  let notificationsBudget: QueryReservation | null = null;
  let scope: ProducerScope;
  try { scope = createProducerScope(completion ? { ...env, DB: completion.db } : env, await beginDrain(env, 'g2', 'accepted-runs')); }
  catch (error) {
    completion?.release();
    if (error instanceof AdmissionUnavailable) return c.json({ error: 'admissions unavailable' }, 503);
    throw error;
  }
  let succeeded = false;
  try {
    if (!db) return c.json({ reconciled: false, reason: 'no DB binding' });
    notificationsBudget = reserveIngressBudgetShare(db, 4, 6);
    const summary = await reconcileAgentRuns(db, {
      triggerApiUrl: env.TRIGGER_API_URL ?? 'https://api.trigger.dev',
      triggerSecretKey: env.TRIGGER_SECRET_KEY,
      githubToken: env.RUNNER_GITHUB_PAT_TEMP, // transition fallback; resolveGithubToken is preferred
      resolveGithubToken: (run, operationDb) => makeGithubTokenResolver({ ...env, DB: operationDb ?? db })(run),
      runnerToken: env.AGENT_RUNNER_TOKEN,
      moreHandsPublicUrl: env.MOREHANDS_PUBLIC_URL,
      fetch,
    });
    const notifications = notificationsBudget
      ? await deliverPendingSlackRunNotifications({ db: notificationsBudget.db, env: env as Record<string, unknown> })
      : { sent: 0, failed: 0, skipped: 0 };
    // Native submission deadlines and canonical settlement own agent-turn termination.
    // A Slack receipt clock must never resend or terminalize work the native runtime still owns.
    succeeded = summary.failed === 0 && summary.skipped === 0 && notifications.failed === 0;
    return c.json({ ...summary, notifications });
  } finally {
    notificationsBudget?.release();
    try { await scope.finish(succeeded); } finally { completion?.release(); }
  }
});

// Nightly REM: the nightly cron in .flue/cloudflare.ts pokes this. The GATE is cheap SQL (projects
// with messages OR terminal runs past their watermarks) — idle projects never dispatch a
// token-costing turn. For each qualifying project we take both batches (advancing each watermark
// server-side) and hand them INLINE to a fresh consolidation session, so the live agent can't
// consume a watermark and reflection turns never pollute a real conversation thread.
app.post('/__internal/reflect-sweep', async (c) => {
  if (!requireHeartbeat(c)) return c.body(null, 404);
  let scope: ProducerScope;
  try { scope = createProducerScope(c.env, await beginIntake(c.env, 'g2', 'reflect')); }
  catch (error) {
    if (error instanceof AdmissionUnavailable) return c.json({ error: 'admissions unavailable' }, 503);
    throw error;
  }
  let succeeded = false;
  try {
    const db = c.env.DB;
    if (!db) return c.json({ swept: 0, reason: 'no DB binding' });

    const projects = new Set([...(await projectsWithUnreflected(db)), ...(await projectsWithUnreflectedRuns(db))]);
    const now = new Date().toISOString();
    let swept = 0;
    for (const projectId of projects) {
      const transcript = await takeUnreflectedBatch(db, projectId);
      const runDigest = await takeUnreflectedRuns(db, projectId);
      if (!transcript && !runDigest) continue; // raced to empty; skip
      await dispatchProject(c.env, {
        agent: 'project',
        id: agentInstanceId(projectId, `reflect:${Date.now()}`), // fresh instance — no carryover, no thread pollution
        input: { kind: 'heartbeat', now, instructions: buildReflectInstructions(transcript, runDigest) },
      });
      swept++;
    }
    succeeded = true;
    return c.json({ swept });
  } finally { c.executionCtx.waitUntil(scope.finish(succeeded)); }
});

// Proactive review sweep (Layer 4): the */2 cron pokes this. Tier-1 gate is pure SQL (unreviewed
// candidate messages AND channel quiet/max-wait AND a budget free) — idle channels cost one query,
// zero tokens. Qualifying projects get ONE review turn in a fresh session whose procedure makes
// silence the default; speaking goes through proactive_reply (budgeted, thread-only, shadow-able).
app.post('/__internal/review-sweep', async (c) => {
  if (!requireHeartbeat(c)) return c.body(null, 404);
  const env = withIngressBudget(c.env), db = env.DB;
  if (db && remainingIngressBudget(db) < 23) return c.json({ deferred: true });
  const completion = db ? reserveIngressBudget(db, 1) : null;
  let scope: ProducerScope;
  try { scope = createProducerScope(completion ? { ...env, DB: completion.db } : env, await beginIntake(env, 'g2', 'review')); }
  catch (error) {
    completion?.release();
    if (error instanceof AdmissionUnavailable) return c.json({ error: 'admissions unavailable' }, 503);
    throw error;
  }
  let succeeded = false;
  try {
    if (!db) return c.json({ swept: 0, reason: 'no DB binding' });

    const projects = await projectsToReview(db);
    const now = new Date().toISOString();
    let swept = 0;
    for (const projectId of projects) {
      // Consume-on-take must have context/admission room before advancing its watermark.
      const operation = reserveIngressBudget(db, 20);
      if (!operation) break;
      try {
        const batch = await takeReviewBatch(operation.db, projectId);
        if (!batch) continue; // raced to empty; skip
        await dispatchProject({ ...env, DB: operation.db }, {
          agent: 'project',
          id: agentInstanceId(projectId, `review:${Date.now()}`), // fresh instance — no carryover, no thread pollution
          input: { kind: 'heartbeat', now, instructions: buildReviewInstructions(batch) },
        });
        swept++;
      } finally { operation.release(); }
    }
    succeeded = true;
    return c.json({ swept });
  } finally {
    try { await scope.finish(succeeded); } finally { completion?.release(); }
  }
});

// Operator connection provisioning (ADR 0003 / D11). Lets the operator add or change a connection's
// METADATA without a code edit + redeploy. Guarded by its OWN token (NOT HEARTBEAT_TOKEN — provisioning
// connections and poking heartbeats are different privilege levels). The SECRET is set separately via
// `wrangler secret put` and is only referenced here by name — this route never receives or stores it.
// HARD LINE: this is OPERATOR-only and out-of-band; the agent (model) can never reach it.
function requireAdmin(c: { env: Env; req: { header(n: string): string | undefined } }): boolean {
  return hasMatchingSecretHeader(c.env.ADMIN_CONNECTIONS_TOKEN, c.req.header('x-morehands-admin-token'));
}

app.get('/__admin/cutover/status', async (c) => {
  if (!requireAdmin(c)) return c.body(null, 404);
  return c.json(await readCutoverStatus(c.env, 'g2'));
});

app.post('/__admin/cutover/admissions', async (c) => {
  if (!requireAdmin(c)) return c.body(null, 404);
  const result = await changeCutoverAdmissions(c.env, await readJsonOrNull(() => c.req.json()));
  return c.json(result.body as Record<string, unknown>, result.status as 200 | 400 | 409 | 503);
});

app.post('/__admin/cutover/identities', async (c) => {
  if (!requireAdmin(c)) return c.body(null, 404);
  const result = await deriveInstanceIdentities(c.env, await readJsonOrNull(() => c.req.json()));
  return c.json(result.body as Record<string, unknown>, result.status as 200 | 400 | 503);
});

app.post('/__admin/cutover/instance', async (c) => {
  if (!requireAdmin(c)) return c.body(null, 404);
  return c.json(await observeAssociatedInstance(c.env, 'g2', await readJsonOrNull(() => c.req.json())) as Record<string, unknown>);
});

// Operator reset: preserve the epoch escape hatch so the next turn starts a fresh native
// instance. Normal failures and retries remain owned by native submission durability.
app.post('/__admin/conversations/reset', async (c) => {
  if (!requireAdmin(c)) return c.body(null, 404);
  const db = c.env.DB;
  if (!db) return c.json({ error: 'no DB binding' }, 500);
  const body = await readJsonOrNull<{ projectId?: string; conversationId?: string }>(() => c.req.json());
  if (!body?.projectId || !body.conversationId) return c.json({ error: 'projectId and conversationId are required' }, 400);
  const epoch = await bumpAgentEpoch(db, body.projectId, body.conversationId);
  if (!epoch) return c.json({ error: 'no conversation target found to reset' }, 404);
  console.log(`[admin] session reset project=${body.projectId} conv=${body.conversationId} epoch=${epoch}`);
  return c.json({ projectId: body.projectId, conversationId: body.conversationId, epoch });
});

app.post('/__admin/connections', async (c) => {
  if (!requireAdmin(c)) return c.body(null, 404); // inert/invisible unless the admin token matches
  const db = c.env.DB;
  if (!db) return c.json({ error: 'no DB binding' }, 500);
  const body = await readJsonOrNull<{
    projectId?: string;
    provider?: string;
    tokenRef?: string;
    connectionRef?: string;
    config?: Record<string, unknown>;
    status?: 'active' | 'disabled';
  }>(() => c.req.json());
  if (!body?.projectId || !body.provider) return c.json({ error: 'projectId and provider are required' }, 400);
  if (!body.tokenRef && !body.connectionRef && body.status !== 'disabled') {
    return c.json({ error: 'tokenRef or connectionRef is required (omit only when disabling)' }, 400);
  }
  await upsertConnection(db, {
    projectId: body.projectId,
    provider: body.provider,
    tokenRef: body.tokenRef,
    connectionRef: body.connectionRef,
    config: body.config,
    status: body.status,
    createdBy: 'admin-route',
  });
  return c.json({ ok: true, projectId: body.projectId, provider: body.provider, status: body.status ?? 'active' });
});

app.get('/__admin/connections', async (c) => {
  if (!requireAdmin(c)) return c.body(null, 404);
  const db = c.env.DB;
  if (!db) return c.json({ error: 'no DB binding' }, 500);
  const projectId = c.req.query('projectId');
  if (!projectId) return c.json({ error: 'projectId query param required' }, 400);
  const connections = await loadConnections(db, projectId); // metadata only — no secret is ever stored or returned
  return c.json({ projectId, connections });
});

app.get('/__admin/code-executions', async (c) => {
  if (!requireAdmin(c)) return c.body(null, 404);
  const db = c.env.DB;
  if (!db) return c.json({ error: 'no DB binding' }, 500);
  const projectId = c.req.query('projectId');
  if (!projectId) return c.json({ error: 'projectId query param required' }, 400);
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 20;
  const executions = await listCodeExecutionAudits(db, projectId, Number.isFinite(limit) ? limit : 20);
  return c.json({ projectId, executions });
});

app.post('/__admin/agent-run-routes/:id/activate', async (c) => {
  if (!requireAdmin(c)) return c.body(null, 404);
  const db = c.env.DB;
  if (!db) return c.json({ error: 'no DB binding' }, 500);
  try {
    const route = await activateAgentRunRoute(db, c.req.param('id'), 'admin-route');
    return c.json({ ok: true, route });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'bad request' }, 400);
  }
});

app.post('/__admin/agent-run-routes/:id/disable', async (c) => {
  if (!requireAdmin(c)) return c.body(null, 404);
  const db = c.env.DB;
  if (!db) return c.json({ error: 'no DB binding' }, 500);
  try {
    const route = await disableAgentRunRoute(db, c.req.param('id'), 'admin-route');
    return c.json({ ok: true, route });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'bad request' }, 400);
  }
});

// Nango auth webhook (Component 3). Nango POSTs here when a Connect flow completes. HMAC-verified
// against the RAW body with NANGO_WEBHOOK_SECRET (a DEDICATED webhook secret, NOT the API key).
// Inert (404) until that secret is set. On a verified auth/creation/success event we store the
// connection_ref under the channel project (tags.end_user_id) — the row makes that provider's tools
// appear next turn. HARD LINE: this writes only a non-secret connection_ref; no token touches D1.
app.post('/nango/webhook', async (c) => {
  const signingKey = c.env.NANGO_WEBHOOK_SECRET;
  if (!signingKey) return c.body(null, 404); // inert/invisible until configured

  const raw = await c.req.text();
  const ok = await verifyNangoWebhook(signingKey, raw, c.req.header('x-nango-hmac-sha256'));
  if (!ok) return c.text('unauthorized', 401);

  const db = c.env.DB;
  if (!db) return c.json({ error: 'no DB binding' }, 500);

  // Deletion FIRST (a deletion event is not a creation). Target the row by connection_ref — the only
  // field guaranteed on a deletion webhook. Disabling makes loadConnectionSpecs drop it → the
  // provider's tools disappear next turn, instead of going stale and erroring on use. NOTE: whether
  // Nango sends this event is unconfirmed (docs list only creation/override) — this is the belt; the
  // braces is fetchToken self-heal (a dead connection_ref 404s → handled at call time regardless).
  const deletion = parseNangoDeletionWebhook(raw);
  if (deletion) {
    const disabled = await disableConnectionByRef(db, deletion.connectionId);
    if (disabled) {
      console.log(`[nango] disconnected provider "${disabled.provider}" for project ${disabled.projectId} (connection ${deletion.connectionId})`);
      await postConnectionNotice({
        db,
        env: c.env as Record<string, unknown>,
        projectId: disabled.projectId,
        text: disconnectedNotice(disabled.provider),
      });
      return c.json({ ok: true, disconnected: disabled.provider, projectId: disabled.projectId });
    }
    console.log(`[nango] deletion for unknown connection_ref ${deletion.connectionId} — nothing to disable`);
    return c.json({ ignored: 'no matching connection' });
  }

  const event = parseNangoAuthWebhook(raw);
  if (!event) {
    const forwarded = await handleNangoForwardWebhook({ db, rawBody: raw });
    if (forwarded.status === 404) return c.body(null, 404);
    if (forwarded.body?.handled || forwarded.body?.ignored) return c.json(forwarded.body ?? {}, forwarded.status as 200 | 400 | 500);
    // non-auth, non-creation, or success:false (failed/abandoned consent) — acknowledge, write nothing.
    console.log('[nango] webhook ignored (not an auth-creation-success event)');
    return c.json({ ignored: true });
  }

  // Generic provider (not in the curated catalog): fetch its API spec from Nango's providers
  // catalog ONCE and persist the non-secret subset in config. Call tools then go DIRECT to the
  // provider (Bearer + base URL); no spec or non-Bearer auth → the per-call Nango proxy fallback,
  // which needs nothing persisted. Spec fetch failure is non-fatal by design.
  if (!isCatalogProvider(event.provider)) {
    const nangoKey = c.env.NANGO_SECRET_KEY;
    const spec = nangoKey ? await fetchProviderApiSpec({ secretKey: nangoKey, provider: event.provider }).catch(() => null) : null;
    if (spec) event.config.api = spec;
    console.log(`[nango] generic provider "${event.provider}" (cfg "${event.providerConfigKey}") — ${spec ? `direct profile persisted (${spec.baseUrl})` : 'no direct spec; proxy fallback'}`);
  }

  await upsertConnection(db, {
    projectId: event.projectId,
    provider: event.provider,
    connectionRef: event.connectionId,
    config: event.config,
    createdBy: 'nango-webhook',
  });
  console.log(`[nango] connected provider "${event.provider}" for project ${event.projectId} (connection ${event.connectionId})`);
  await postConnectionNotice({
    db,
    env: c.env as Record<string, unknown>,
    projectId: event.projectId,
    text: connectedNotice(event.provider),
  });
  return c.json({ ok: true, projectId: event.projectId, provider: event.provider });
});

async function boundedSlackBody(request: Request): Promise<string> {
  const limit = 1_000_000;
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.length;
    if (size > limit) { await reader.cancel(); throw new RangeError('Slack acceptance body too large'); }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
app.post('/slack/events', async (c) => {
  let raw: string;
  try { raw = await boundedSlackBody(c.req.raw); }
  catch (error) { return c.text('invalid Slack event body', error instanceof RangeError ? 413 : 400); }
  const verified = await verifySlackSignature(c.env.SLACK_SIGNING_SECRET ?? '', raw,
    c.req.header('x-slack-request-timestamp'), c.req.header('x-slack-signature'));
  if (!verified) return c.text('unauthorized', 401);
  let body: ReturnType<typeof parseSlackEventEnvelope>;
  try { body = parseSlackEventEnvelope(raw); } catch { return c.text('invalid Slack event', 400); }
  const verification = slackUrlVerification(body);
  if (verification) return c.json({ challenge: verification.challenge });
  const ev = slackUserMessageEvent(body);
  if (!ev) {
    if (body.event?.type === 'message' && !body.event.bot_id && (!body.event.subtype || body.event.subtype === 'file_share')) {
      return c.text('invalid Slack user event', 400);
    }
    return c.body(null, 200);
  }
  let event: Awaited<ReturnType<typeof verifiedIngressEvent>>;
  try { event = await verifiedIngressEvent(raw, body, ev); } catch { return c.text('invalid Slack event identity', 400); }
  const env = withIngressBudget(c.env);
  try {
    if (env.CUTOVER_CONTROL !== 'd1') throw new Error('Durable control unavailable');
    const accepted = await acceptSlackIngress(requireIngressDb(env.DB), event);
    if (accepted.status === 'closed') return c.json({ error: 'admissions unavailable' }, 503);
    if (accepted.status === 'conflict') return c.json({ error: 'event identity conflict' }, 409);
    try {
      c.executionCtx.waitUntil(recoverSlackIngress(env, { limit: 1, ingressId: accepted.id }).catch(() => {
        console.log('[slack-ingress] recovery deferred');
      }));
    } catch { console.log('[slack-ingress] recovery deferred'); }
    return c.body(null, 200);
  } catch { return c.json({ error: 'durable acceptance unavailable' }, 503); }
});

app.post('/__internal/slack-ingress/reconcile', async (c) => {
  if (!requireHeartbeat(c)) return c.body(null, 404);
  const body = await readJsonOrNull<unknown>(() => c.req.json());
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
    return c.json({ error: 'invalid recovery request' }, 400);
  }
  try { return c.json(await recoverSlackIngress(c.env, { limit: 1 })); }
  catch { return c.json({ error: 'ingress recovery unavailable' }, 503); }
});

// Slash commands (/hands <subcommand>): read-only observability views, answered ephemerally
// in the direct slash response (all fast D1 reads — inside Slack's 3s window, no response_url).
// Same signature verification as /slack/events; the command must also be declared in the Slack
// app manifest or Slack won't deliver it.
app.post('/slack/commands', async (c) => {
  const raw = await c.req.text();

  const verified = await verifySlackSignature(
    c.env.SLACK_SIGNING_SECRET ?? '',
    raw,
    c.req.header('x-slack-request-timestamp'),
    c.req.header('x-slack-signature'),
  );
  if (!verified) return c.text('unauthorized', 401);

  const payload = parseSlashCommandPayload(raw);
  const binding = await bindingBySlack(payload.teamId, payload.channelId, c.env.DB);
  if (!binding) {
    return c.json({
      response_type: 'ephemeral',
      text: 'This channel is not bound to a MoreHands project yet. @mention the bot first to create the binding.',
    });
  }

  const text = await runSlashCommand(payload.text, {
    binding,
    db: c.env.DB,
    env: c.env as Record<string, unknown>,
  });
  return c.json({ response_type: 'ephemeral', text });
});

export default app;
