import { Hono } from 'hono';
import { observe } from '@flue/runtime';
import { dispatchProject } from './gateway/dispatch';
import { verifySlackSignature } from './slack/verify';
import { fetchChannelHistory, fetchThreadReplies, renderThreadBackscroll } from './slack/threads';
import { mentionsBot, stripMention } from './slack/mentions';
import { postWorkingAck } from './slack/ack';
import { createSlackTurnActivity, handleObservedSlackActivity } from './slack/activity';
import { findActiveSlackTurnActivity } from './slack/activity';
import { addReaction } from './slack/post';
import { recordSlackConversationFiles } from './slack/file-authorizations';
import { dispatchSlackTurnWithFallback } from './slack/dispatch';
import { seedReplyTracker, attachReplySubmission } from './slack/delivery';
import type { DispatchReceipt } from '@flue/runtime';
import { parseSlashCommandPayload, runSlashCommand } from './slack/commands';
import {
  parseSlackEventEnvelope,
  slackEventId,
  slackUrlVerification,
  slackUserMessageEvent,
  isDirectMessage,
} from './slack/events';
import { bindingBySlack, bindingByProject, agentInstanceId, autoCreateBinding } from './project/bindings';
import { loadPersona } from './project/persona';
import { deploymentConfig, isKnownTeam } from './config/deployment';
import { normalizeSlackMessage } from './shared/canonical';
import { upsertConversationTarget, loadAgentEpoch, bumpAgentEpoch, conversationScope } from './project/conversations';
import { claimEvent, type KVLike } from './shared/idempotency';
import type { D1Like } from './skills/repository';
import { agentPostedInConversation, logMessage, projectsWithUnreflected, projectsWithUnreflectedRuns, takeUnreflectedBatch, takeUnreflectedRuns, buildReflectInstructions } from './knowledge/reflection';
import {
  isTrivialChatter,
  projectsToReview,
  takeReviewBatch,
  buildReviewInstructions,
  buildOverhearInstructions,
  overheardLine,
  loadReviewState,
  answerBudgetFree,
} from './review';
import { upsertConnection, loadConnections, connectedNotice, disconnectedNotice, disableConnectionByRef } from './connections/repository';
import { verifyNangoWebhook, parseNangoAuthWebhook, parseNangoDeletionWebhook, fetchProviderApiSpec } from './providers/nango';
import { isCatalogProvider } from './connections/catalog';
import { buildScheduledInput } from './gateway/scheduled';
import { hasMatchingSecretHeader } from './gateway/auth';
import { readJsonOrNull } from './gateway/json';
import { reconcileReplies, reconcileNativeReplies, type ReplyAgentNamespace } from './gateway/replies';
import { postConnectionNotice } from './connections/notices';
import { handleInternalWorkItemRequest } from './workbench/gateway';
import { handleSourceChangeRunCallback } from './workbench/source-change';
import { handleLinearComment, handleLinearWebhook } from './agent-runs/linear';
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
  const summary = await reconcileReplies(c.env.DB, c.env, {
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

  if (!(await claimEvent(c.env.SLACK_EVENTS, `sched:${body.fireId}`))) {
    return c.json({ deduped: true }); // alarm retry / double-fire — already dispatched
  }

  const binding = await bindingByProject(body.projectId, c.env.DB);
  if (!binding || binding.status !== 'active') return c.json({ skipped: 'no active binding' });

  const scheduled = await buildScheduledInput({
    db: c.env.DB,
    projectId: body.projectId,
    kind: body.kind,
    payload: body.payload,
    now: new Date().toISOString(),
  });
  if (scheduled.skipped) return c.json({ skipped: scheduled.skipped });
  const input = scheduled.input;

  await dispatchProject(c.env, {
    agent: 'project',
    id: agentInstanceId(body.projectId, `job:${body.jobId}`),
    idempotencyKey: `sched:${body.fireId}`,
    input,
  });
  return c.json({ dispatched: true, jobId: body.jobId, skill: input.skill ?? null });
});

// Internal workbench intake. Future Linear/Slack/manual adapters call this to create a durable
// work item. Dispatch is tracked on a work_run because Flue dispatch is an external side effect,
// not part of the D1 write.
app.post('/__internal/work-items', async (c) => {
  const result = await handleInternalWorkItemRequest(
    {
      db: c.env.DB,
      expectedToken: c.env.HEARTBEAT_TOKEN,
      actualToken: c.req.header('x-morehands-token'),
      body: await readJsonOrNull(() => c.req.json()),
    },
    { bindingByProject, dispatch: (request) => dispatchProject(c.env, request) },
  );
  if (result.status === 404) return c.body(null, 404);
  return c.json(result.body ?? {}, result.status as 200 | 400 | 500);
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
  if (result.dispatch) c.executionCtx.waitUntil(result.dispatch());
  if (result.status === 404) return c.body(null, 404);
  return c.json(result.body ?? {}, result.status as 200 | 400 | 500);
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
  const db = c.env.DB;
  if (!db) return c.json({ reconciled: false, reason: 'no DB binding' });
  const summary = await reconcileAgentRuns(db, {
    triggerApiUrl: c.env.TRIGGER_API_URL ?? 'https://api.trigger.dev',
    triggerSecretKey: c.env.TRIGGER_SECRET_KEY,
    githubToken: c.env.RUNNER_GITHUB_PAT_TEMP, // transition fallback; resolveGithubToken is preferred
    resolveGithubToken: makeGithubTokenResolver(c.env),
    runnerToken: c.env.AGENT_RUNNER_TOKEN,
    moreHandsPublicUrl: c.env.MOREHANDS_PUBLIC_URL,
    fetch,
  });
  const notifications = await deliverPendingSlackRunNotifications({ db, env: c.env as Record<string, unknown> });
  // Native submission deadlines and canonical settlement own agent-turn termination.
  // A Slack receipt clock must never resend or terminalize work the native runtime still owns.
  return c.json({ ...summary, notifications });
});

// Nightly REM: the nightly cron in .flue/cloudflare.ts pokes this. The GATE is cheap SQL (projects
// with messages OR terminal runs past their watermarks) — idle projects never dispatch a
// token-costing turn. For each qualifying project we take both batches (advancing each watermark
// server-side) and hand them INLINE to a fresh consolidation session, so the live agent can't
// consume a watermark and reflection turns never pollute a real conversation thread.
app.post('/__internal/reflect-sweep', async (c) => {
  if (!requireHeartbeat(c)) return c.body(null, 404);
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
  return c.json({ swept });
});

// Proactive review sweep (Layer 4): the */2 cron pokes this. Tier-1 gate is pure SQL (unreviewed
// candidate messages AND channel quiet/max-wait AND a budget free) — idle channels cost one query,
// zero tokens. Qualifying projects get ONE review turn in a fresh session whose procedure makes
// silence the default; speaking goes through proactive_reply (budgeted, thread-only, shadow-able).
app.post('/__internal/review-sweep', async (c) => {
  if (!requireHeartbeat(c)) return c.body(null, 404);
  const db = c.env.DB;
  if (!db) return c.json({ swept: 0, reason: 'no DB binding' });

  const projects = await projectsToReview(db);
  const now = new Date().toISOString();
  let swept = 0;
  for (const projectId of projects) {
    const batch = await takeReviewBatch(db, projectId);
    if (!batch) continue; // raced to empty; skip
    await dispatchProject(c.env, {
      agent: 'project',
      id: agentInstanceId(projectId, `review:${Date.now()}`), // fresh instance — no carryover, no thread pollution
      input: { kind: 'heartbeat', now, instructions: buildReviewInstructions(batch) },
    });
    swept++;
  }
  return c.json({ swept });
});

// Operator connection provisioning (ADR 0003 / D11). Lets the operator add or change a connection's
// METADATA without a code edit + redeploy. Guarded by its OWN token (NOT HEARTBEAT_TOKEN — provisioning
// connections and poking heartbeats are different privilege levels). The SECRET is set separately via
// `wrangler secret put` and is only referenced here by name — this route never receives or stores it.
// HARD LINE: this is OPERATOR-only and out-of-band; the agent (model) can never reach it.
function requireAdmin(c: { env: Env; req: { header(n: string): string | undefined } }): boolean {
  return hasMatchingSecretHeader(c.env.ADMIN_CONNECTIONS_TOKEN, c.req.header('x-morehands-admin-token'));
}

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

app.post('/slack/events', async (c) => {
  const raw = await c.req.text();

  const verified = await verifySlackSignature(
    c.env.SLACK_SIGNING_SECRET ?? '',
    raw,
    c.req.header('x-slack-request-timestamp'),
    c.req.header('x-slack-signature'),
  );
  if (!verified) return c.text('unauthorized', 401);

  const body = parseSlackEventEnvelope(raw);

  const verification = slackUrlVerification(body);
  if (verification) return c.json({ challenge: verification.challenge });

  const ev = slackUserMessageEvent(body);
  if (!ev) return c.body(null, 200);

  const teamId = body.team_id ?? '';
  let binding = await bindingBySlack(teamId, ev.channel, c.env.DB);
  if (!binding) {
    // No binding yet. If this is a channel of a KNOWN team and the bot is being addressed, the
    // gateway provisions a per-channel project (HARD LINE: gateway-created on a verified Slack
    // signature for an allowlisted team — NOT the agent). Otherwise acknowledge and stay silent.
    const dep = deploymentConfig(c.env);
    const addressed = mentionsBot(ev.text ?? '', dep.slackBotId);
    if (c.env.DB && isKnownTeam(c.env, teamId) && addressed) {
      await autoCreateBinding(c.env.DB, {
        teamId,
        channelId: ev.channel,
        transportBotId: dep.slackBotId,
        transportTokenRef: dep.slackTokenRef,
      });
      binding = await bindingBySlack(teamId, ev.channel, c.env.DB);
    }
    if (!binding) return c.body(null, 200); // unknown team, not addressed, or create failed → silent
  }

  // Engage policy:
  //  - @mention anywhere                         -> engage
  //  - reply in a thread the bot already posted in -> continue (no re-mention)
  //  - everything else                            -> log ambient (Layer 2), stay silent
  const text = ev.text ?? '';
  const token = (c.env as Record<string, string | undefined>)[binding.transportTokenRef];
  // Fetch the thread ONCE (if any) and reuse it for BOTH the participation check and the backscroll
  // we hand the agent — so a threaded turn is no longer context-blind. One conversations.replies call.
  const threadReplies =
    ev.thread_ts && token
      ? await fetchThreadReplies(token, ev.channel, ev.thread_ts).catch(() => [])
      : [];

  const eventId = slackEventId(body, ev);
  // Normalize once — both the ambient-log branch and the engaged path below use this.
  const msg = normalizeSlackMessage(
    eventId,
    teamId,
    { channel: ev.channel, ts: ev.ts, thread_ts: ev.thread_ts, user: ev.user, text: stripMention(text, binding.transportBotId) },
    binding,
  );

  // Engage when @mentioned, when replying in a thread the bot already posted in, or when this is a
  // DM (a 1:1 is implicitly addressed to the agent — every non-trivial message is for it, no
  // @mention needed). Participation is checked against Slack authorship AND our own transcript:
  // persona posts (chat:write.customize) are bot_message subtypes with NO `user` field, so the
  // Slack-side check stops matching the moment a channel hatches — the D1 record is authorship we own.
  const isDm = isDirectMessage(ev);
  const engaged =
    mentionsBot(text, binding.transportBotId) ||
    (isDm && !isTrivialChatter(text)) ||
    threadReplies.some((m) => m.user === binding.transportBotId) ||
    (!!ev.thread_ts && !!c.env.DB && (await agentPostedInConversation(c.env.DB, msg.projectId, msg.conversationId).catch(() => false)));

  if (!engaged) {
    // Ambient ingestion (Layer 2): remember every message in a bound channel even when we won't
    // answer it, so the cross-thread index (Layer 3) and proactive review (Layer 4) can see the
    // whole room. Flagged ambient:true so nightly REM keeps consolidating ONLY bot conversations.
    // Deduped against Slack's at-least-once retries with the same KV claim the engaged path uses
    // (an event is ambient XOR engaged, so the two claim sites never fire on the same event_id).
    if (c.env.DB && (await claimEvent(c.env.SLACK_EVENTS, eventId))) {
      await logMessage(c.env.DB, {
        projectId: msg.projectId,
        conversationId: msg.conversationId,
        senderId: msg.senderId,
        role: 'user',
        text: msg.text,
        ambient: true,
      }).catch(() => {});

      // Overhearing (Layer 4 v2): in an opt-in channel, evaluate this fresh message instantly and
      // capability-judged — reply only if the agent can genuinely help (the turn decides via
      // proactive_reply, which enforces venue + budget + REVIEW_MODE). The daily answer budget is
      // checked HERE, before spending any LLM judgment: once it's exhausted the agent stops
      // evaluating entirely (no proactive spend) until the UTC reset. @mentions always still engage.
      const overhearing = binding.overhear === true && !isDm && !isTrivialChatter(msg.text);
      if (overhearing) {
        const state = await loadReviewState(c.env.DB, msg.projectId).catch(() => null);
        if (answerBudgetFree(state, Date.now())) {
          await dispatchProject(c.env, {
            agent: 'project',
            // Fresh instance keyed to the message — no thread/session carryover, idempotent per message.
            id: agentInstanceId(msg.projectId, `overhear:${ev.ts}`),
            idempotencyKey: `overhear:${eventId}`,
            input: {
              kind: 'heartbeat',
              now: new Date().toISOString(),
              instructions: buildOverhearInstructions(overheardLine(msg.conversationId, msg.senderId, msg.text)),
            },
          }).catch((e) => console.log(`[overhear] dispatch failed project=${msg.projectId}: ${e instanceof Error ? e.message : 'error'}`));
        }
      }
    }
    return c.body(null, 200);
  }

  // Store the exact reply target before the idempotency claim. If this D1 write fails,
  // Slack can retry and repair the target instead of us suppressing a turn that can no
  // longer reply to its originating conversation.
  if (c.env.DB) {
    await upsertConversationTarget(c.env.DB, {
      projectId: msg.projectId,
      conversationId: msg.conversationId,
      provider: msg.provider,
      externalAccountId: msg.externalAccountId,
      externalSpaceId: msg.externalSpaceId,
      externalConversationId: msg.externalConversationId,
      transportTokenRef: binding.transportTokenRef,
    });
  }

  // Idempotency: Slack redelivers the same event_id on retry (at-least-once). Claim it before
  // dispatch so a retry can't fire a second reply. (Ambient messages claim it too, above — every
  // persisted message is deduped now, not just dispatch-bound ones.)
  if (!(await claimEvent(c.env.SLACK_EVENTS, eventId))) {
    return c.body(null, 200); // duplicate delivery — already handled
  }
  if (c.env.DB) {
    await recordSlackConversationFiles(c.env.DB, {
      projectId: msg.projectId,
      conversationId: msg.conversationId,
      files: ev.files,
    });
  }

  // A busy conversation joins the native response immediately. This gate controls only
  // Slack chrome: it never parks, drains, or suppresses a distinct accepted input.
  const activeTurn = c.env.DB
    ? await findActiveSlackTurnActivity(c.env.DB, msg.projectId, msg.conversationId).catch(() => null)
    : null;
  if (activeTurn && token) c.executionCtx.waitUntil(addReaction(token, ev.channel, ev.ts, 'eyes'));

  // Post the working acknowledgement after the event claim and capture its timestamp
  // for progress and completed/failed receipt chrome. Final answers post separately below it.
  // A Slack hiccup returns undefined without blocking admission. The same trusted persona
  // is captured for the answer outbox; later progress cannot overwrite that answer.
  const ackPersona = c.env.DB ? await loadPersona(c.env.DB, msg.projectId).catch(() => null) : null;
  const ackMessageTs = activeTurn ? undefined : await postWorkingAck({
    token,
    channel: msg.externalSpaceId,
    threadTs: msg.externalConversationId,
    persona: ackPersona,
  });

  if (c.env.DB && ackMessageTs) {
    await createSlackTurnActivity(c.env.DB, {
      projectId: msg.projectId,
      sessionId: `conv:${msg.conversationId}`,
      conversationId: msg.conversationId,
      slackChannelId: msg.externalSpaceId,
      slackThreadTs: msg.externalConversationId,
      ackMessageTs,
      transportTokenRef: binding.transportTokenRef,
    }).catch((e) => console.log(`[activity] create receipt failed: ${e instanceof Error ? e.message : 'error'}`));
  }

  // Log the engaged turn to the transcript (ambient defaults to 0, so nightly REM consolidates it).
  // Best-effort — a logging hiccup must never block the reply.
  if (c.env.DB) {
    await logMessage(c.env.DB, {
      projectId: msg.projectId,
      conversationId: msg.conversationId,
      senderId: msg.senderId,
      role: 'user',
      text: msg.text,
    }).catch(() => {});
  }

  // Epoch-aware instance id: an operator reset routes the next turn to a fresh native instance.
  const agentEpoch = c.env.DB ? await loadAgentEpoch(c.env.DB, msg.projectId, msg.conversationId).catch(() => 0) : 0;
  const instanceId = agentInstanceId(msg.projectId, conversationScope(msg.conversationId, agentEpoch));
  if (c.env.DB) {
    await seedReplyTracker(c.env.DB, {
      instanceId,
      eventId,
      target: {
        projectId: msg.projectId,
        agentSlug: 'default',
        conversationId: msg.conversationId,
        provider: 'slack',
        externalAccountId: msg.externalAccountId,
        externalSpaceId: msg.externalSpaceId,
        externalConversationId: msg.externalConversationId,
        transportTokenRef: binding.transportTokenRef,
      },
      persona: ackPersona,
      ...(ackMessageTs ? { ackMessageTs } : {}),
      publish: true,
    });
  }

  await dispatchSlackTurnWithFallback(
    {
      agent: 'project',
      id: instanceId,
      eventId,
      idempotencyKey: `slack:${eventId}`,
      // Forward the author identity in neutral terms so history retains who said what — the
      // future reflection job reads senderId from it to attribute facts. (The initializer itself
      // can't see this; only the model does.)
      input: {
        message: msg.text,
        conversationId: msg.conversationId,
        // Preserve the product envelope for status tools; final delivery uses the trusted tracker.
        // Omitted for joined input so it never borrows an earlier receipt after that response closes.
        ...(ackMessageTs ? { ackMessageTs } : {}),
        provider: msg.provider,
        accountId: msg.externalAccountId,
        senderId: msg.senderId,
        ...(threadReplies.length
          ? { threadContext: renderThreadBackscroll(threadReplies, binding.transportBotId, { excludeTs: ev.ts }) }
          : {}),
        // Top-level turns get channel backscroll the same way threaded turns get the thread —
        // recent room history straight from Slack (including messages from before the bot joined),
        // so "what's been going on here" isn't answered from the bot's own transcript alone.
        ...(!ev.thread_ts && token
          ? await fetchChannelHistory(token, ev.channel)
              .then((h) => {
                const rendered = renderThreadBackscroll(h, binding.transportBotId, { excludeTs: ev.ts });
                return rendered ? { channelContext: rendered } : {};
              })
              .catch(() => ({}))
          : {}),
        // Metadata only (id/name/mimetype/size) — bytes stay in Slack until the model
        // pulls a file into the sandbox with workspace_load_slack_file.
        ...(ev.files?.length ? { attachedFiles: ev.files } : {}),
      },
    },
    {
      executionCtx: c.executionCtx,
      token,
      channel: msg.externalSpaceId,
      threadTs: msg.externalConversationId,
    },
    {
      dispatch: (request) => dispatchProject(c.env, request),
      onRejected: async () => {
        if (c.env.DB) await c.env.DB.prepare(`UPDATE slack_reply_trackers SET status='failed',outcome='failed',updated_at=?
          WHERE instance_id=? AND event_id=? AND submission_id IS NULL AND status='pending'`)
          .bind(Date.now(), instanceId, eventId).run();
      },
      onAccepted: async (accepted) => {
        const receipt = accepted as DispatchReceipt;
        if (c.env.DB) await attachReplySubmission(c.env.DB, {
          instanceId, eventId, submissionId: receipt.submissionId, uid: receipt.uid,
        });
      },
    },
  );

  return c.body(null, 200); // ack within Slack's 3s window; agent replies async
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
