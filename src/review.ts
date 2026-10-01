// Proactive review (Layer 4) — the only layer where the agent speaks UNPROMPTED, so the design
// centers on restraint (see docs/superpowers/specs/2026-06-02-proactive-review-layer4-design.md,
// revised 2026-06-11 with the Notion-agent learnings: hybrid debounced sweep, split budgets,
// receipt-or-clear-expertise).
//
// Shape: ingest marks candidate messages with a cheap regex (no LLM) → the */2 cron sweep gates
// per project on pure SQL (candidates exist AND channel quiet ~90s — or a candidate has waited
// past max-wait — AND a budget is free) → one review turn reads the batch, drafts, self-critiques,
// and almost always stays silent. Speaking happens only through proactive_reply, which enforces
// venue (thread-only, this binding's channel only), budgets, and shadow mode IN CODE.

import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { D1Like } from './skills/repository';
import type { Binding } from './project/bindings';
import type { ConversationTarget } from './project/conversations';

export const REVIEW_BATCH_LIMIT = 100;
export const ANSWER_BUDGET_PER_DAY = 5; // proactive answers (with receipts) — service, not noise
export const OBSERVATION_BUDGET_MS = 24 * 60 * 60 * 1000; // unprompted observations — ≤1 per 24h
export const REVIEW_QUIET_MS = 90_000; // debounce: let the room finish talking first
export const REVIEW_MAX_WAIT_MS = 5 * 60_000; // anti-starvation: busy channels still get reviewed

// ── Ingest-time candidate heuristic (no LLM) ────────────────────────────────────────────────────

const CHATTER_RE = /^(thanks|thank you|thx|ty|lol|lmao|haha+|nice|cool|great|noted|ok+|okay|done|got it|\+1|👍|🙏|🎉)[\s!.…🙏👍🎉]*$/i;
const QUESTION_OPENER_RE = /^(how|what|where|when|why|who|which|does|do|did|is|are|can|could|should|would|will|any\s?one)\b/i;
const ASK_PHRASE_RE = /\b(does anyone|can (someone|anyone|somebody)|anyone know|any idea|where (can|do|did) (i|we)|how (do|can|did) (i|we)|what('s| is) the)\b/i;

/** Does this overheard message look like an answerable question/request? Cheap and deliberately
 *  conservative — it only decides whether a review turn WAKES; the turn itself decides whether
 *  anything is worth saying. Skips chatter, fragments, and messages addressed to a specific
 *  person (Notion's "not meant for me" rule). */
export function isReviewCandidate(text: string): boolean {
  const t = text.trim();
  if (t.length < 15) return false;
  if (CHATTER_RE.test(t)) return false;
  if (/^\s*<@U[A-Z0-9]+>/.test(t)) return false; // opens by addressing a specific person — theirs to answer
  return t.includes('?') || QUESTION_OPENER_RE.test(t) || ASK_PHRASE_RE.test(t);
}

/** Not worth a turn: empty, or a bare ack/emoji ("thanks", "👍"). Used to skip free in DMs and
 *  overhearing channels before spending an LLM judgment — unlike isReviewCandidate, it does NOT
 *  require question-shape (overhearing judges capability, not grammar). */
export function isTrivialChatter(text: string): boolean {
  const t = (text ?? '').trim();
  return t.length === 0 || CHATTER_RE.test(t);
}

// ── Budgets ─────────────────────────────────────────────────────────────────────────────────────

export interface ReviewState {
  last_reviewed_message_id: number;
  last_observation_post_at: number | null;
  answer_posts_today: number;
  answer_posts_day: string | null;
}

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function answerBudgetFree(state: Pick<ReviewState, 'answer_posts_today' | 'answer_posts_day'> | null, now: number): boolean {
  return answerBudgetRemaining(state, now) > 0;
}

/** Proactive answers left today (resets at UTC midnight). Drives both the ingest-time "stop
 *  evaluating to save money" gate and the "last reply for today" heads-up. */
export function answerBudgetRemaining(state: Pick<ReviewState, 'answer_posts_today' | 'answer_posts_day'> | null, now: number): number {
  if (!state || state.answer_posts_day !== utcDay(now)) return ANSWER_BUDGET_PER_DAY; // new day resets the counter
  return Math.max(0, ANSWER_BUDGET_PER_DAY - state.answer_posts_today);
}

export function observationBudgetFree(state: Pick<ReviewState, 'last_observation_post_at'> | null, now: number): boolean {
  return !state?.last_observation_post_at || now - state.last_observation_post_at >= OBSERVATION_BUDGET_MS;
}

/** Consume one budget unit after a LIVE proactive post. Targeted upsert — never touches the
 *  watermark columns (takeReviewBatch owns those). */
export async function recordProactivePost(db: D1Like, projectId: string, kind: 'answer' | 'observation', now: number = Date.now()): Promise<void> {
  if (kind === 'observation') {
    await db
      .prepare(
        `INSERT INTO review_state(project_id, last_observation_post_at) VALUES(?,?)
         ON CONFLICT(project_id) DO UPDATE SET last_observation_post_at=excluded.last_observation_post_at`,
      )
      .bind(projectId, now)
      .run();
    return;
  }
  const day = utcDay(now);
  await db
    .prepare(
      `INSERT INTO review_state(project_id, answer_posts_today, answer_posts_day) VALUES(?,1,?)
       ON CONFLICT(project_id) DO UPDATE SET
         answer_posts_today = CASE WHEN review_state.answer_posts_day = excluded.answer_posts_day THEN review_state.answer_posts_today + 1 ELSE 1 END,
         answer_posts_day = excluded.answer_posts_day`,
    )
    .bind(projectId, day)
    .run();
}

export async function loadReviewState(db: D1Like, projectId: string): Promise<ReviewState | null> {
  return db
    .prepare('SELECT last_reviewed_message_id, last_observation_post_at, answer_posts_today, answer_posts_day FROM review_state WHERE project_id=?')
    .bind(projectId)
    .first<ReviewState>();
}

// ── Tier 1: the sweep gate (pure SQL + arithmetic, no LLM) ──────────────────────────────────────

interface GateRow {
  project_id: string;
  candidates: number;
  oldest_candidate_at: number | null;
  last_message_at: number | null;
  last_observation_post_at: number | null;
  answer_posts_today: number | null;
  answer_posts_day: string | null;
}

/** Projects that deserve a review turn right now: unreviewed candidate messages exist, AND the
 *  channel has gone quiet (debounce — judge the burst as a whole) OR the oldest candidate has
 *  waited past max-wait (anti-starvation in busy rooms), AND at least one budget is free. */
export async function projectsToReview(
  db: D1Like,
  opts: { now?: number; quietMs?: number; maxWaitMs?: number } = {},
): Promise<string[]> {
  const now = opts.now ?? Date.now();
  const quietMs = opts.quietMs ?? REVIEW_QUIET_MS;
  const maxWaitMs = opts.maxWaitMs ?? REVIEW_MAX_WAIT_MS;
  const { results } = await db
    .prepare(
      `SELECT m.project_id AS project_id,
              SUM(CASE WHEN m.review_candidate=1 AND m.id > COALESCE(r.last_reviewed_message_id,0) THEN 1 ELSE 0 END) AS candidates,
              MIN(CASE WHEN m.review_candidate=1 AND m.id > COALESCE(r.last_reviewed_message_id,0) THEN m.created_at END) AS oldest_candidate_at,
              MAX(m.created_at) AS last_message_at,
              r.last_observation_post_at AS last_observation_post_at,
              r.answer_posts_today AS answer_posts_today,
              r.answer_posts_day AS answer_posts_day
         FROM messages m
         LEFT JOIN review_state r ON r.project_id = m.project_id
        GROUP BY m.project_id`,
    )
    .bind()
    .all<GateRow>();
  return (results ?? [])
    .filter((row) => {
      if (!row.candidates) return false;
      const quiet = row.last_message_at != null && now - row.last_message_at >= quietMs;
      const starving = row.oldest_candidate_at != null && now - row.oldest_candidate_at >= maxWaitMs;
      if (!quiet && !starving) return false;
      const budget = { answer_posts_today: row.answer_posts_today ?? 0, answer_posts_day: row.answer_posts_day };
      return answerBudgetFree(budget, now) || observationBudgetFree(row, now);
    })
    .map((row) => row.project_id);
}

// ── Tier 2: take the batch (consume-on-take) and build the procedure ────────────────────────────

/** Everything since the watermark — AMBIENT INCLUDED (this is the consumer ambient ingestion was
 *  built for) — rendered one line per message with the conversation_id the model needs to target
 *  proactive_reply. Advances the watermark before dispatch so a crashed turn drops the batch
 *  rather than re-litigating it forever. */
export async function takeReviewBatch(db: D1Like, projectId: string, limit: number = REVIEW_BATCH_LIMIT): Promise<string | null> {
  const state = await db
    .prepare('SELECT last_reviewed_message_id FROM review_state WHERE project_id=?')
    .bind(projectId)
    .first<{ last_reviewed_message_id: number }>();
  const since = state?.last_reviewed_message_id ?? 0;

  const { results } = await db
    .prepare(
      `SELECT id, conversation_id, sender_id, role, text, review_candidate FROM messages
        WHERE project_id=? AND id>? ORDER BY id LIMIT ${limit}`,
    )
    .bind(projectId, since)
    .all<{ id: number; conversation_id: string; sender_id: string; role: string; text: string; review_candidate: number }>();
  const rows = results ?? [];
  if (!rows.length) return null;

  const maxId = rows[rows.length - 1].id;
  await db
    .prepare(
      `INSERT INTO review_state(project_id, last_reviewed_message_id, last_reviewed_at) VALUES(?,?,?)
       ON CONFLICT(project_id) DO UPDATE SET last_reviewed_message_id=excluded.last_reviewed_message_id, last_reviewed_at=excluded.last_reviewed_at`,
    )
    .bind(projectId, maxId, Date.now())
    .run();

  return rows
    .map((r) => `(${r.conversation_id}) ${r.role === 'agent' ? 'you' : r.sender_id}: ${r.text}${r.review_candidate ? ' [question?]' : ''}`)
    .join('\n');
}

const REVIEW_PROCEDURE =
  `PROACTIVE REVIEW (background — you woke on a timer; nobody asked for you). Below is recent channel ` +
  `activity, one line per message, prefixed with its conversationId; lines marked [question?] tripped a ` +
  `cheap question heuristic. Almost always the right move is to stay SILENT and go back to sleep. Speak ` +
  `only if ONE thing clears every bar below.\n\n` +
  `You may speak for:\n` +
  `• an UNANSWERED question you can genuinely answer — and it is STILL unanswered at the end of the batch ` +
  `(if someone answered it, or the asker answered themselves, stay silent);\n` +
  `• a strong, specific link to an earlier discussion — call search_channel or read_channel_history first ` +
  `and cite only a real match;\n` +
  `• a commitment that is now due — or call set_reminder to follow up on one you notice coming.\n\n` +
  `Never speak for: opinion/open-ended questions ("what do you all think…"), anything addressed to a ` +
  `specific person or team, chatter, or anything you would merely be *plausibly* helpful on.\n\n` +
  `RECEIPTS: an answer needs a citable source — a memory you quote, a thread you verified, channel ` +
  `history, or a connected tool result. Without one, answer ONLY IF it is objective technical knowledge ` +
  `you are certain of (e.g. what an HTTP status means). If you would hedge, stay silent.\n\n` +
  `Draft it, then self-critique: would a good teammate actually interrupt for THIS, now, unprompted? ` +
  `If you hesitate, stay silent — that is the normal, correct outcome.\n\n` +
  `To speak: call proactive_reply with the conversationId of the relevant line, kind "answer" (an ` +
  `unanswered question you are answering) or "observation" (links, follow-ups, anything else), and 1–2 ` +
  `sentences plus your receipt. At most ONE call. Replies land in that message's thread — never the ` +
  `channel root. Do NOT use reply_to_conversation or update_status in this turn. If nothing clears the ` +
  `bar, call no tool and produce no output.\n\n` +
  `ACTIVITY:\n`;

export function buildReviewInstructions(batch: string): string {
  return REVIEW_PROCEDURE + batch;
}

// Instant overhearing (Layer 4 v2): one fresh message just arrived in an opt-in channel — not
// addressed to you. Capability-forward (does my toolset let me genuinely help?), not the batch
// sweep's silence-first framing, but still restrained: most overheard messages aren't for you.
const OVERHEAR_PROCEDURE =
  `OVERHEARING (background — you are watching this channel, but this message was NOT addressed to you). ` +
  `Decide in one pass whether to chime in.\n\n` +
  `Reply ONLY if you can GENUINELY help with your actual capabilities — e.g.:\n` +
  `• a question you can really answer (from a connected tool, channel history/memory you can cite, or ` +
  `objective technical knowledge you are certain of);\n` +
  `• a task you have the tools to do (e.g. create/look up a Linear issue, search Gmail) — for anything ` +
  `destructive or significant, OFFER and ask for confirmation, never just do it;\n` +
  `• a strong, specific link to earlier discussion — verify with search_channel/read_channel_history first.\n\n` +
  `Stay SILENT for: chatter, opinions and open-ended "what do you all think", anything addressed to a ` +
  `specific person or team, or anything you would only be vaguely/plausibly helpful on. When unsure, stay silent.\n\n` +
  `To speak: call proactive_reply once with this message's conversationId, kind "answer" (answering/ ` +
  `offering) or "observation" (a link or follow-up), and 1–2 sentences. It threads onto the message. ` +
  `Do NOT use reply_to_conversation or update_status here. If it doesn't clear the bar, call no tool and ` +
  `produce no output — that is the common, correct outcome.\n\n` +
  `MESSAGE:\n`;

/** Format a single overheard message the way takeReviewBatch formats a batch line, so the turn's
 *  proactive_reply call can reference its conversationId. */
export function overheardLine(conversationId: string, senderId: string, text: string): string {
  return `(${conversationId}) ${senderId}: ${text}`;
}

export function buildOverhearInstructions(line: string): string {
  return OVERHEAR_PROCEDURE + line;
}

// ── proactive_reply: the only mouth Layer 4 has ─────────────────────────────────────────────────

/** Build the thread target for a conversationId ("slack:<team>:<channel>:<ts>") from TRUSTED
 *  binding config. The channel always comes from the binding — a conversationId naming another
 *  channel is refused, so the model cannot redirect a proactive post outside its own room — and
 *  the reply is threaded onto the conversation's ts BY CONSTRUCTION (never the channel root). */
export function threadTargetFromConversationId(binding: Binding, conversationId: string): ConversationTarget | null {
  const parts = conversationId.split(':');
  if (parts.length !== 4 || parts[0] !== 'slack') return null;
  const [, team, channel, ts] = parts;
  if (team !== binding.externalAccountId || channel !== binding.externalSpaceId || !ts) return null;
  return {
    projectId: binding.projectId,
    agentSlug: 'default',
    conversationId,
    provider: 'slack',
    externalAccountId: binding.externalAccountId,
    externalSpaceId: binding.externalSpaceId,
    externalConversationId: ts,
    transportTokenRef: binding.transportTokenRef,
  };
}

export interface ProactiveReplyDeps {
  db: D1Like;
  projectId: string;
  binding: Binding;
  /** 'live' posts; anything else is shadow mode — drafts are logged, nothing posts, no budget spent. */
  mode: string | undefined;
  send: (target: ConversationTarget, text: string) => Promise<void>;
  log?: (message: string) => void;
  now?: () => number;
}

export function proactiveReplyTool(deps: ProactiveReplyDeps): ToolDefinition {
  const log = deps.log ?? console.log;
  const nowFn = deps.now ?? Date.now;
  return defineTool({
    name: 'proactive_reply',
    description:
      'Speak UNPROMPTED into a thread (proactive review turns only). Pass the conversationId of the ' +
      'message you are responding to, kind "answer" (answering an unanswered question, with a receipt) or ' +
      '"observation" (a verified link to earlier discussion, a due commitment), and 1–2 sentences. Budgeted ' +
      'and thread-only; use sparingly — silence is the default.',
    input: v.object({
      conversationId: v.pipe(v.string(), v.description('The (conversationId) prefix of the activity line you are replying to.')),
      kind: v.pipe(v.union([v.literal('answer'), v.literal('observation')]), v.description('"answer" = answering an unanswered question; "observation" = anything else.')),
      text: v.pipe(v.string(), v.description('1–2 sentences + your receipt (link/source). Short — it interrupts people.')),
    }),
    async run({ data: { conversationId, kind, text } }) {
      const conv = String(conversationId);
      const k = kind === 'answer' ? 'answer' : 'observation';
      const body = String(text).trim();
      if (!body) throw new Error('proactive_reply needs non-empty text.');

      const target = threadTargetFromConversationId(deps.binding, conv);
      if (!target) throw new Error(`conversationId "${conv}" does not belong to this channel; refusing.`);

      if (deps.mode !== 'live') {
        log(`[review-draft] (${k}) ${conv}: ${body}`);
        return 'drafted (shadow mode — not posted, no budget spent). An operator reviews drafts before enabling live mode.';
      }

      const now = nowFn();
      const state = await loadReviewState(deps.db, deps.projectId);
      if (k === 'answer' && !answerBudgetFree(state, now)) {
        return `not posted: today's proactive-answer budget (${ANSWER_BUDGET_PER_DAY}) is spent. Stay silent.`;
      }
      if (k === 'observation' && !observationBudgetFree(state, now)) {
        return 'not posted: the 24h observation budget is spent. Stay silent.';
      }

      // When this answer spends the last of the daily budget, tack a quiet heads-up onto it so the
      // silence that follows (the agent stops evaluating overheard messages until reset) isn't a
      // mystery. @mentions always still work — that's the escape hatch we point them to.
      const lastOfDay = k === 'answer' && answerBudgetRemaining(state, now) <= 1;
      const outgoing = lastOfDay
        ? `${body}\n\n_(That's my last unprompted reply for today — @mention me anytime and I'll always answer.)_`
        : body;

      await deps.send(target, outgoing);
      await recordProactivePost(deps.db, deps.projectId, k, now);
      log(`[review] proactive ${k} posted project=${deps.projectId} conv=${conv}`);
      return `posted (${k}) into the thread.`;
    },
  });
}
