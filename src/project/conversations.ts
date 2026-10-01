import type { Binding } from './bindings';
import { DEFAULT_AGENT_SLUG } from './bindings';
import { personaIdentity, type Persona } from './persona';
import type { D1Like } from '../skills/repository';
import { postMessage, editMessage } from '../slack/post';
import { chunkSlackText, formatSlackText, SLACK_TEXT_LIMIT } from '../slack/format';
import { completeSlackTurnActivity, renderSlackActivityReceipt, shouldPostFinalBelowActivity } from '../slack/activity';

export type Provider = 'slack';

export interface ConversationTarget {
  projectId: string;
  agentSlug: string;
  conversationId: string;
  provider: Provider;
  externalAccountId: string;
  externalSpaceId: string;
  externalConversationId: string | null;
  transportTokenRef: string;
}

export interface UpsertConversationTargetInput {
  projectId: string;
  agentSlug?: string;
  conversationId: string;
  provider: Provider;
  externalAccountId: string;
  externalSpaceId: string;
  externalConversationId: string;
  transportTokenRef: string;
}

export async function upsertConversationTarget(db: D1Like, input: UpsertConversationTargetInput): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO conversation_targets(
         project_id, agent_slug, conversation_id, provider, external_account_id,
         external_space_id, external_conversation_id, transport_token_ref,
         created_at, updated_at
       )
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(project_id, agent_slug, conversation_id) DO UPDATE SET
         provider=excluded.provider,
         external_account_id=excluded.external_account_id,
         external_space_id=excluded.external_space_id,
         external_conversation_id=excluded.external_conversation_id,
         transport_token_ref=excluded.transport_token_ref,
         updated_at=excluded.updated_at`,
    )
    .bind(
      input.projectId,
      input.agentSlug ?? DEFAULT_AGENT_SLUG,
      input.conversationId,
      input.provider,
      input.externalAccountId,
      input.externalSpaceId,
      input.externalConversationId,
      input.transportTokenRef,
      now,
      now,
    )
    .run();
}

// ── Session epoch (wedged-thread cure) ──────────────────────────────────────────────────────────
// An operator can bump this scope via /__admin/conversations/reset to start a fresh native
// conversation, rehydrated from D1 + Slack backscroll. Native durability owns automatic retries.

/** Operator reset version within the current native instance generation. */
export function conversationScope(conversationId: string, epoch: number): string {
  return epoch > 0 ? `conv:${conversationId}~e${epoch}` : `conv:${conversationId}`;
}

export async function loadAgentEpoch(
  db: D1Like,
  projectId: string,
  conversationId: string,
  agentSlug: string = DEFAULT_AGENT_SLUG,
): Promise<number> {
  const row = await db
    .prepare('SELECT agent_epoch FROM conversation_targets WHERE project_id=? AND agent_slug=? AND conversation_id=?')
    .bind(projectId, agentSlug, conversationId)
    .first<{ agent_epoch: number }>();
  return row?.agent_epoch ?? 0;
}

/** Abandon the conversation's current session DO. Returns the new epoch (0 = no target row to
 *  bump, nothing to abandon). */
export async function bumpAgentEpoch(
  db: D1Like,
  projectId: string,
  conversationId: string,
  agentSlug: string = DEFAULT_AGENT_SLUG,
): Promise<number> {
  await db
    .prepare(
      'UPDATE conversation_targets SET agent_epoch=agent_epoch+1, updated_at=? WHERE project_id=? AND agent_slug=? AND conversation_id=?',
    )
    .bind(Date.now(), projectId, agentSlug, conversationId)
    .run();
  return loadAgentEpoch(db, projectId, conversationId, agentSlug);
}

export async function loadConversationTarget(
  db: D1Like,
  projectId: string,
  agentSlug: string,
  conversationId: string,
): Promise<ConversationTarget | null> {
  const row = await db
    .prepare(
      `SELECT
         project_id, agent_slug, conversation_id, provider, external_account_id,
         external_space_id, external_conversation_id, transport_token_ref
       FROM conversation_targets
       WHERE project_id=? AND agent_slug=? AND conversation_id=?`,
    )
    .bind(projectId, agentSlug, conversationId)
    .first<{
      project_id: string;
      agent_slug: string;
      conversation_id: string;
      provider: Provider;
      external_account_id: string;
      external_space_id: string;
      external_conversation_id: string | null;
      transport_token_ref: string;
    }>();

  if (!row) return null;
  return {
    projectId: row.project_id,
    agentSlug: row.agent_slug,
    conversationId: row.conversation_id,
    provider: row.provider,
    externalAccountId: row.external_account_id,
    externalSpaceId: row.external_space_id,
    externalConversationId: row.external_conversation_id,
    transportTokenRef: row.transport_token_ref,
  };
}

export function topLevelTargetFromBinding(
  binding: Binding,
  agentSlug: string = DEFAULT_AGENT_SLUG,
): ConversationTarget {
  return {
    projectId: binding.projectId,
    agentSlug,
    conversationId: '',
    provider: binding.provider,
    externalAccountId: binding.externalAccountId,
    externalSpaceId: binding.externalSpaceId,
    externalConversationId: null,
    transportTokenRef: binding.transportTokenRef,
  };
}

// Resolve the destination the model is addressing: a stored per-conversation target when it
// relays a conversationId, or the project's top-level target for heartbeat/new posts. Shared by
// the reply and status tools so the two never drift in how they pick a destination.
export async function resolveTarget(
  db: D1Like | undefined,
  binding: Binding,
  projectId: string,
  agentSlug: string,
  conversationId?: string,
): Promise<ConversationTarget | null> {
  const conv = conversationId ? String(conversationId) : '';
  if (!conv) return topLevelTargetFromBinding(binding, agentSlug);
  return db ? loadConversationTarget(db, projectId, agentSlug, conv) : null;
}

// Deliver text to a resolved target. When ackMessageTs is supplied, EDIT that message in place
// (the "On it…" ack becomes the reply) instead of posting a new one — so a turn reads as a single
// evolving message. ackMessageTs is opaque to us: the gateway captured it and the model relays it
// back in the tool args, alongside conversationId. Absent → a fresh post (heartbeats, new threads).
export async function sendToConversationTarget(
  env: Record<string, unknown>,
  target: ConversationTarget,
  text: string,
  ackMessageTs?: string,
  persona?: Persona | null,
): Promise<void> {
  const token = env[target.transportTokenRef];
  if (typeof token !== 'string' || !token) {
    throw new Error(`Missing transport token env "${target.transportTokenRef}".`);
  }

  if (target.provider === 'slack') {
    // Identity rides on fresh posts only — edits (chat.update) inherit the posted identity.
    const identity = personaIdentity(persona);
    const maxChars =
      typeof env.SLACK_REPLY_MAX_CHARS === 'number'
        ? env.SLACK_REPLY_MAX_CHARS
        : typeof env.SLACK_REPLY_MAX_CHARS === 'string' && env.SLACK_REPLY_MAX_CHARS.trim()
          ? Number(env.SLACK_REPLY_MAX_CHARS)
          : SLACK_TEXT_LIMIT;
    const formatted = formatSlackText(text);
    const parts = chunkSlackText(formatted, {
      maxChars: Number.isFinite(maxChars) && maxChars > 0 ? maxChars : SLACK_TEXT_LIMIT,
      label: true,
    });

    if (ackMessageTs) {
      await editMessage(token, target.externalSpaceId, ackMessageTs, parts[0] ?? '', { format: false });
      for (const part of parts.slice(1)) {
        await postMessage(token, target.externalSpaceId, part, target.externalConversationId ?? undefined, { format: false, ...identity });
      }
    } else {
      let threadTs = target.externalConversationId ?? undefined;
      const firstTs = await postMessage(token, target.externalSpaceId, parts[0] ?? '', threadTs, { format: false, ...identity });
      if (!threadTs) threadTs = firstTs;
      for (const part of parts.slice(1)) {
        await postMessage(token, target.externalSpaceId, part, threadTs, { format: false, ...identity });
      }
    }
    return;
  }

  const provider: never = target.provider;
  throw new Error(`Unsupported provider "${provider}".`);
}

export async function sendFinalToConversationTarget(
  env: Record<string, unknown>,
  target: ConversationTarget,
  text: string,
  opts: {
    db?: D1Like;
    projectId: string;
    sessionId: string;
    ackMessageTs?: string;
    persona?: Persona | null;
  },
): Promise<void> {
  const ackMessageTs = opts.ackMessageTs;
  const shouldPreserveReceipt =
    ackMessageTs && (await shouldPostFinalBelowActivity(opts.db, opts.projectId, opts.sessionId));

  if (!shouldPreserveReceipt) {
    await sendToConversationTarget(env, target, text, ackMessageTs, opts.persona);
    if (ackMessageTs && opts.db) {
      await completeSlackTurnActivity(opts.db, opts.projectId, opts.sessionId).catch(() => null);
    }
    return;
  }

  const token = env[target.transportTokenRef];
  if (typeof token !== 'string' || !token) {
    throw new Error(`Missing transport token env "${target.transportTokenRef}".`);
  }

  const completed = opts.db ? await completeSlackTurnActivity(opts.db, opts.projectId, opts.sessionId).catch(() => null) : null;
  if (completed) {
    await editMessage(token, target.externalSpaceId, ackMessageTs, renderSlackActivityReceipt(completed), { format: false }).catch(
      (e) => console.log(`[activity] final receipt update failed: ${e instanceof Error ? e.message : 'error'}`),
    );
  }

  await sendToConversationTarget(env, target, text, undefined, opts.persona);
}
