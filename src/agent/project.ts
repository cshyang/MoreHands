'use agent';

import { env as workerEnv } from 'cloudflare:workers';
import * as v from 'valibot';
import { defineTool, useDelivery, useInitialData, useModel, useTool, type AgentProps, type ToolDefinition } from '@flue/runtime';
import { parseAgentInstanceId, resolveModel } from '../project/bindings';
import { projectContextForDelivery, parseProjectDispatchInput, isEngagedProjectInput, type ProjectContext } from './context';
import { ensureNativeModelAuth } from './providers';
import { personaTools } from '../project/persona';
import { overhearingTools } from '../project/overhearing';
import { resolveTarget, sendFinalToConversationTarget, sendToConversationTarget } from '../project/conversations';
import { fetchChannelHistory, fetchThreadReplies, renderThreadBackscroll } from '../slack/threads';
import { findActiveSlackTurnActivity, withSlackActivityLock } from '../slack/activity';
import { proactiveReplyTool } from '../review';
import { skillTools, type D1Like } from '../skills/repository';
import { reminderTools } from './reminders';
import { buildInstructions } from './prompt';
import { selfStatusTool } from './self';
import { memoryTools } from '../knowledge/memory';
import { peopleTools } from '../knowledge/people';
import { userTools } from '../knowledge/users';
import { searchTools } from '../knowledge/search';
import { workbenchTools } from '../workbench/tools';
import { sourceChangeTools } from '../workbench/source-change';
import { logMessage } from '../knowledge/reflection';
import { connectionRuntimeFromSnapshot } from '../connections/runtime';
import { setupStatusTool } from '../setup/status';
import { codeModeLimits, codeModeTools, hasCodeModeCapability, type DynamicWorkerLoaderLike } from '../code-mode/code-mode';
import { getSandbox } from '@cloudflare/sandbox';
import { hasWorkspaceCapability, workspaceLimits, workspaceTools, type SandboxLike } from '../workspace/workspace';
import { workspaceSlackFileTools } from '../workspace/slack-files';

export { replyRuntime as cloudflare } from '../slack/reply-runtime';

// The project agent. Addressed at /agents/project/<id>, id = "project:<projectId>:agent:<slug>"
// (slug = "default" until a channel hosts multiple personas). Each instance is a persistent
// Durable Object — the per-(project, persona) boundary.
//
// Access is enforced by TOOLS, not the prompt: replies resolve a stored conversation target
// plus token ref from trusted config; skills/reminders/memory are scoped to this projectId.
// The model controls only the content, never the destination or another project's data.
//
// Gateway reads D1 before dispatch and carries a metadata-only snapshot on EVERY signal.
// This synchronous render sees fresh context before useModel chooses the submission's model.
export function Project({ id }: AgentProps) {
  const { projectId, slug } = parseAgentInstanceId(id);
  const env = workerEnv as Record<string, unknown>;
  ensureNativeModelAuth(env);
  const db = env.DB as D1Like | undefined;
  const delivery = useDelivery();
  const attrs = delivery.kind === 'signal' ? delivery.attributes : undefined;
  const initial = useInitialData<ProjectContext | undefined>();
  const context = projectContextForDelivery(id, attrs?.snapshot, initial);
  const binding = context?.binding;
  const model = resolveModel(binding?.model);
  useModel(model);
  if (!binding || !context) return `No active binding for project "${projectId}". Do not attempt to post anywhere.`;

  const { persona, personality, catalog, memoryBlock } = context;
  const input = delivery.kind === 'signal' ? parseProjectDispatchInput(attrs?.input ?? delivery.body) : null;
  const engaged = isEngagedProjectInput(attrs, input);
  // Destination and acknowledgement are read from trusted admitted input, never tool arguments.
  const conversationId = attrs?.conversationId ?? (typeof input?.conversationId === 'string' ? input.conversationId : '');
  const ackMessageTs = attrs?.ackMessageTs ?? (typeof input?.ackMessageTs === 'string' ? input.ackMessageTs : undefined);

  const connectionRuntime = connectionRuntimeFromSnapshot({
    db,
    env,
    projectId,
    snapshot: context.connections,
    // Post the connect link straight into the thread, so request_connection never hands the
    // high-entropy URL to the model (which stalls reproducing it token-by-token).
    postConnectionLink: async ({ conversationId, text }) => {
      try {
        const target = await resolveTarget(db, binding, projectId, slug, conversationId);
        if (!target) return false;
        await sendToConversationTarget(env, target, text, undefined, persona);
        return true;
      } catch {
        return false;
      }
    },
  });

  const replyToConversation = defineTool({
    name: 'reply_to_conversation',
    description:
      'Intentionally publish a scheduled or autonomous result. Omit conversationId for a new channel post, or supply the project conversation named by your reminder/work instructions. Unavailable for engaged user replies.',
    input: v.object({ text: v.string(), conversationId: v.optional(v.string()) }),
    async run({ data: { text, conversationId } }) {
      if (engaged) throw new Error('Engaged replies are delivered automatically from your final text.');
      const conv = conversationId ?? '';
      const target = await resolveTarget(db, binding, projectId, slug, conv);
      if (!target) {
        throw new Error(`No reply target found for conversationId "${conv}".`);
      }
      await sendFinalToConversationTarget(env, target, String(text), {
        db,
        projectId,
        sessionId: conv ? `conv:${conv}` : '',
        persona,
      });
      // Log the agent's own post to the transcript (the other half of the conversation reflection
      // consolidates). REM turns are told not to post, so this never logs reflection's own output.
      if (db) await logMessage(db, { projectId, conversationId: conv, senderId: 'agent', role: 'agent', text: String(text) }).catch(() => {});
      return { output: 'sent' };
    },
  });

  // Ephemeral progress note for slow, multi-step turns. Reuses the reply path's target resolution,
  // but NEVER logs to the transcript (it's chrome, not conversation) and NEVER throws — a failed
  // status must not derail the real answer. Model-driven; the prompt says when to call it.
  const updateStatus = defineTool({
    name: 'update_status',
    description:
      'Update the existing working note before slow, multi-step work. Use up to 3 meaningful phase updates, ' +
      'with human-readable activity like Checking the repo or Running tests; do not list raw tool names or arguments. ' +
      'The system fixes its thread and acknowledgement. This is not your final reply; finish with plain answer text.',
    input: v.object({ text: v.string() }),
    async run({ data: { text } }) {
      if (!db || !engaged || !conversationId || !ackMessageTs) return { output: 'no working note — status skipped' };
      try {
        return await withSlackActivityLock(db, projectId, `conv:${conversationId}`, async () => {
          const activity = await findActiveSlackTurnActivity(db, projectId, conversationId);
          if (!activity || activity.ackMessageTs !== ackMessageTs) return { output: 'working note settled — status skipped' };
          const target = await resolveTarget(db, binding, projectId, slug, conversationId);
          if (!target) return { output: 'no target — status skipped' };
          await sendToConversationTarget(env, target, text, ackMessageTs, persona);
          return { output: 'posted' };
        });
      } catch (e) {
        return { output: `status not posted: ${e instanceof Error ? e.message : 'error'}` };
      }
    },
  });

  // Bot token (for resolving Slack user names via users.info). Same ref the reply path uses.
  const botToken = env[binding.transportTokenRef] as string | undefined;

  // Real Slack history on demand — the channel's actual past (conversations.history/replies),
  // not the bot's own transcript, which only holds turns the bot saw. This is what makes
  // "what happened in this channel?" and "catch up on this thread" answerable.
  const readChannelHistory = defineTool({
    name: 'read_channel_history',
    description:
      'Read the REAL recent message history of this Slack channel (or one thread) straight from Slack — ' +
      'includes messages from before you joined and threads you never participated in. Your own transcript ' +
      'search only covers turns you were part of; use THIS when asked about channel activity, to catch up on ' +
      'a thread, or whenever someone references a discussion you do not remember. Pass threadTs (a thread ' +
      "root ts) to read that thread; omit it for the channel's recent top-level messages.",
    input: v.object({ threadTs: v.optional(v.string()), limit: v.optional(v.number()) }),
    async run({ data: { threadTs, limit } }) {
      if (!botToken) throw new Error('No Slack token available for history reads.');
      const channel = binding.externalSpaceId;
      const messages = threadTs
        ? await fetchThreadReplies(botToken, channel, String(threadTs))
        : await fetchChannelHistory(botToken, channel, { limit: Number(limit) || 50 });
      const rendered = renderThreadBackscroll(messages, binding.transportBotId, { maxChars: 12_000 });
      return { output: rendered || 'No messages found (empty history, or the bot lacks access to this channel).' };
    },
  });
  const codingRunnerUrl = typeof env.CODING_RUNNER_URL === 'string' ? env.CODING_RUNNER_URL : '';
  const workbenchRunnerToken = typeof env.WORKBENCH_RUNNER_TOKEN === 'string' ? env.WORKBENCH_RUNNER_TOKEN : '';
  const agentRunnerToken = typeof env.AGENT_RUNNER_TOKEN === 'string' ? env.AGENT_RUNNER_TOKEN : '';
  const triggerSecretKey = typeof env.TRIGGER_SECRET_KEY === 'string' ? env.TRIGGER_SECRET_KEY : '';
  const runnerGithubToken = typeof env.RUNNER_GITHUB_PAT_TEMP === 'string' ? env.RUNNER_GITHUB_PAT_TEMP : '';
  const moreHandsPublicUrl = typeof env.MOREHANDS_PUBLIC_URL === 'string' ? env.MOREHANDS_PUBLIC_URL : '';
  const dynamicWorkerLoader = env.DYNAMIC_WORKER_LOADER as DynamicWorkerLoaderLike | undefined;
  const hasCodeMode = hasCodeModeCapability({ db, loader: dynamicWorkerLoader });
  const limits = codeModeLimits(env);
  // One sandbox container per project, resolved lazily so the container only
  // boots when a workspace tool actually runs (~6s cold start after idle).
  const sandboxNamespace = env.SANDBOX as Parameters<typeof getSandbox>[0] | undefined;
  const sandbox = sandboxNamespace
    ? () => getSandbox(sandboxNamespace, projectId) as unknown as SandboxLike
    : undefined;
  const hasWorkspace = hasWorkspaceCapability({ db, sandbox });

  const tools: ToolDefinition[] = [
    ...(!engaged ? [replyToConversation] : []),
    ...(engaged ? [updateStatus] : []),
    selfStatusTool({
      projectId,
      agentSlug: slug,
      engaged,
      model,
      hasDb: !!db,
      hasBotToken: !!botToken,
      hasCodingRunner: !!codingRunnerUrl && !!workbenchRunnerToken,
      // GitHub write credential mirrors resolveDispatchGithubToken: the project's connected
      // GitHub App installation token (preferred) or the RUNNER_GITHUB_PAT_TEMP fallback.
      hasAgentRunner:
        !!triggerSecretKey &&
        !!agentRunnerToken &&
        (connectionRuntime.state.some((s) => s.provider === 'github' && s.status === 'connected') || !!runnerGithubToken) &&
        !!moreHandsPublicUrl,
      hasLinearAgentIngress: typeof env.LINEAR_WEBHOOK_SECRET === 'string',
      hasCodeMode,
      codeModeLimits: hasCodeMode ? limits : null,
      hasWorkspace,
      workspaceLimits: hasWorkspace ? workspaceLimits(env) : null,
      canRequestConnections: connectionRuntime.canRequestConnections,
      providerCatalog: connectionRuntime.providerCatalog,
      connectionState: connectionRuntime.state,
      connectionToolNames: connectionRuntime.tools.map((tool) => tool.name),
    }),
    setupStatusTool({ db, binding, projectId, env }),
    ...(db ? skillTools(db, projectId) : []),
    ...personaTools(db, projectId),
    ...overhearingTools(db, projectId),
    ...reminderTools(db, projectId),
    ...(db ? memoryTools(db, projectId) : []),
    ...peopleTools(db, projectId),
    ...userTools(db, botToken),
    readChannelHistory,
    // Layer 4's only mouth: unprompted posts go through here (budgets + thread-only + shadow
    // mode enforced in the tool). Registered always, used only by review-sweep turns per prompt.
    ...(db
      ? [
          proactiveReplyTool({
            db,
            projectId,
            binding,
            mode: typeof env.REVIEW_MODE === 'string' ? env.REVIEW_MODE : undefined,
            send: async (target, text) => {
              await sendToConversationTarget(env, target, text, undefined, persona);
              await logMessage(db, { projectId, conversationId: target.conversationId, senderId: 'agent', role: 'agent', text }).catch(() => {});
            },
          }),
        ]
      : []),
    ...(db ? searchTools(db, projectId) : []),
    ...codeModeTools({ db, loader: dynamicWorkerLoader, projectId, env }),
    ...workspaceTools({ db, sandbox, projectId, env }),
    ...workspaceSlackFileTools({
      db,
      sandbox,
      projectId,
      env,
      token: botToken,
      // Same trust line as reply_to_conversation: the model names a conversation,
      // trusted config supplies channel/thread/token.
      resolveTarget: async (conversationId) => {
        const target = await resolveTarget(db, binding, projectId, slug, conversationId);
        if (!target) return null;
        const token = env[target.transportTokenRef] as string | undefined;
        if (!token) return null;
        return { channelId: target.externalSpaceId, threadTs: target.externalConversationId, token };
      },
    }),
    ...(db ? workbenchTools(db, projectId) : []),
    ...(db ? sourceChangeTools({ db, projectId, runnerUrl: codingRunnerUrl, runnerToken: workbenchRunnerToken }) : []),
    ...connectionRuntime.tools,
  ];

  for (const tool of tools) useTool(tool);
  return buildInstructions({
    projectName: binding.projectId,
    personality,
    catalog,
    memoryBlock,
    connectionsBlock: connectionRuntime.connectionsBlock,
    engaged,
  });
}

Project.agentName = 'project';
Project.initialData = v.optional(v.unknown());
Project.durability = { maxAttempts: 3, timeoutMs: 15 * 60_000 };
