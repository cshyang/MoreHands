// Nightly reflection ("REM"): consolidate the day's experience into durable memory, the way
// sleep distils episodic experience into semantic memory. Two episodic streams feed it:
//   1. CONVERSATIONS — the `messages` table (logged by app.ts + the reply tool).
//   2. THE RUN RECORD — terminal `agent_runs` rows (what the agent DID: dispatched coding
//      runs, their outcomes and errors). Rung one of the reflection ladder: operational
//      patterns become MEMORY only — no skills, no self-filed issues, no fixes from REM.
// Once a night a sweep hands each project's new batch to a REM turn that calls
// save_memory/update_memory/forget_memory (and save_skill, for conversation procedures).
//
// Trigger = cheap schedule, gate = watermark: the LLM turn runs only when a project has something
// new since last night, so idle projects cost one SQL query and zero tokens. Batches are handed
// to the turn INLINE (not via a tool) so the live agent can't accidentally consume a watermark,
// and watermarks advance server-side here (consume-on-take; a failed turn loses that batch —
// best-effort is fine for background consolidation). Messages and runs have INDEPENDENT
// watermarks (last_message_id / last_run_completed_at), so consuming one stream never starves
// the other.

import type { D1Like } from '../skills/repository';

const BATCH_LIMIT = 300; // cap one night's batch so a busy channel can't blow the context window
const RUN_BATCH_LIMIT = 50; // runs are denser than chat lines; 50 is a heavy day
const RUN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // first-ever sweep must not backfill all history
const TERMINAL_RUN_STATUSES = "('completed','failed','cancelled')"; // inlined: D1 binds no lists

export interface LogMessageInput {
  projectId: string;
  conversationId: string;
  senderId: string; // 'slack:<team>:<user>' for people, 'agent' for the bot
  role: 'user' | 'agent';
  text: string;
  /** True for a message the bot overheard but did not engage (Layer 2 ambient ingestion).
   *  Ambient rows feed the cross-thread index/review but are SKIPPED by nightly REM below. */
  ambient?: boolean;
  /** True when the ingest-time heuristic flags this as an answerable question/request — the
   *  proactive review's (Layer 4) Tier-1 wake signal. Computed by isReviewCandidate in review.ts. */
  reviewCandidate?: boolean;
  /** Stable ingress effect id. Present only for durable writes guarded by migration 0031. */
  deliveryId?: string;
  /** Frozen ingestion time for retries; defaults to the current clock for legacy callers. */
  now?: number;
}

// Best-effort transcript logging. Called from app.ts (inbound) and the reply tool (outbound).
export async function logMessage(db: D1Like, m: LogMessageInput): Promise<void> {
  const text = m.text.trim();
  if (!text) return;
  const createdAt = m.now ?? Date.now();
  if (m.deliveryId === undefined) {
    await db
      .prepare(
        'INSERT INTO messages(project_id, conversation_id, sender_id, role, text, ambient, review_candidate, created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(m.projectId, m.conversationId, m.senderId, m.role, text, m.ambient ? 1 : 0, m.reviewCandidate ? 1 : 0, createdAt)
      .run();
    return;
  }

  await db
    .prepare(
      'INSERT INTO messages(project_id, conversation_id, sender_id, role, text, ambient, review_candidate, created_at, delivery_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(delivery_id) DO NOTHING',
    )
    .bind(m.projectId, m.conversationId, m.senderId, m.role, text, m.ambient ? 1 : 0, m.reviewCandidate ? 1 : 0, createdAt, m.deliveryId)
    .run();
  const existing = await db
    .prepare('SELECT project_id, conversation_id, sender_id, role, text, ambient FROM messages WHERE delivery_id=?')
    .bind(m.deliveryId)
    .first<{ project_id: string; conversation_id: string; sender_id: string; role: string; text: string; ambient: number }>();
  if (
    !existing
    || existing.project_id !== m.projectId
    || existing.conversation_id !== m.conversationId
    || existing.sender_id !== m.senderId
    || existing.role !== m.role
    || existing.text.trim() !== text
    || existing.ambient !== (m.ambient ? 1 : 0)
  ) {
    throw new Error('transcript delivery ID conflict');
  }
}

/** Has the agent itself ever posted in this conversation? The engage policy's thread-participation
 *  check against OUR transcript instead of Slack message authorship — persona posts
 *  (chat:write.customize) are bot_message subtypes WITHOUT a `user` field, so matching Slack's
 *  `user` against the bot id silently fails the moment a channel hatches. This record is ours and
 *  transport-quirk-proof. */
export async function agentPostedInConversation(db: D1Like, projectId: string, conversationId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS x FROM messages WHERE project_id=? AND conversation_id=? AND role='agent' LIMIT 1")
    .bind(projectId, conversationId)
    .first<{ x: number }>();
  return !!row;
}

// The nightly sweep's gate: which projects have messages past their watermark. Cheap SQL, no LLM —
// idle projects simply don't appear, so they never dispatch a (token-costing) REM turn.
export async function projectsWithUnreflected(db: D1Like): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT m.project_id AS project_id
         FROM messages m
         LEFT JOIN reflection_state r ON r.project_id = m.project_id
        WHERE m.id > COALESCE(r.last_message_id, 0) AND m.ambient = 0
        GROUP BY m.project_id`,
    )
    .bind()
    .all<{ project_id: string }>();
  return (results ?? []).map((r) => r.project_id);
}

// Take this project's unreflected batch (oldest-first, capped) and advance the watermark to it.
// Consume-on-take: the sweep advances before dispatch, so a crashed REM turn drops the batch
// rather than reprocessing it forever. Returns null when there's nothing new.
export async function takeUnreflectedBatch(db: D1Like, projectId: string): Promise<string | null> {
  const state = await db
    .prepare('SELECT last_message_id FROM reflection_state WHERE project_id=?')
    .bind(projectId)
    .first<{ last_message_id: number }>();
  const since = state?.last_message_id ?? 0;

  const { results } = await db
    .prepare(
      `SELECT id, conversation_id, sender_id, role, text FROM messages
        WHERE project_id=? AND id>? AND ambient = 0 ORDER BY id LIMIT ${BATCH_LIMIT}`,
    )
    .bind(projectId, since)
    .all<{ id: number; conversation_id: string; sender_id: string; role: string; text: string }>();
  const rows = results ?? [];
  if (!rows.length) return null;

  const maxId = rows[rows.length - 1].id;
  await db
    .prepare(
      `INSERT INTO reflection_state(project_id, last_message_id, last_reflected_at) VALUES(?,?,?)
       ON CONFLICT(project_id) DO UPDATE SET last_message_id=excluded.last_message_id, last_reflected_at=excluded.last_reflected_at`,
    )
    .bind(projectId, maxId, Date.now())
    .run();

  // One line per message, grouped by conversation, attributed by sender (so the model can map
  // facts to people). 'you' = the agent's own posts.
  const lines = rows.map(
    (r) => `(${r.conversation_id}) ${r.role === 'agent' ? 'you' : r.sender_id}: ${r.text}`,
  );
  return lines.join('\n');
}

// ── The run record (rung one) ───────────────────────────────────────────────────────────────────

/** The nightly gate's runs half: projects with terminal runs past their run watermark (within the
 *  lookback window). Cheap SQL, no LLM — mirrors projectsWithUnreflected for messages. */
export async function projectsWithUnreflectedRuns(db: D1Like, now: number = Date.now()): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT r.project_id AS project_id
         FROM agent_runs r
         LEFT JOIN reflection_state s ON s.project_id = r.project_id
        WHERE r.completed_at IS NOT NULL
          AND r.status IN ${TERMINAL_RUN_STATUSES}
          AND r.completed_at > MAX(COALESCE(s.last_run_completed_at, 0), ?)
        GROUP BY r.project_id`,
    )
    .bind(now - RUN_LOOKBACK_MS)
    .all<{ project_id: string }>();
  return (results ?? []).map((r) => r.project_id);
}

function runLine(r: { status: string; source_type: string; linear_identifier: string | null; target_repo: string; kit: string; summary: string | null; error: string | null; pr_url: string | null }): string {
  const who = r.linear_identifier ? `${r.source_type} ${r.linear_identifier}` : r.source_type;
  const tail =
    r.status === 'failed'
      ? `error: ${(r.error ?? 'unknown').replace(/\s+/g, ' ').slice(0, 200)}`
      : `${r.summary ? r.summary.replace(/\s+/g, ' ').slice(0, 200) : 'no summary'}${r.pr_url ? ` (${r.pr_url})` : ''}`;
  return `[${r.status}] ${who} → ${r.target_repo} (kit ${r.kit}): ${tail}`;
}

/** Take this project's unreflected terminal runs (oldest-first, capped, bounded by the lookback
 *  window) and advance the run watermark. Same consume-on-take contract as messages; the message
 *  watermark is untouched. Returns a compact one-line-per-run digest, or null when nothing new. */
export async function takeUnreflectedRuns(db: D1Like, projectId: string, now: number = Date.now()): Promise<string | null> {
  const state = await db
    .prepare('SELECT last_run_completed_at FROM reflection_state WHERE project_id=?')
    .bind(projectId)
    .first<{ last_run_completed_at: number | null }>();
  const since = Math.max(state?.last_run_completed_at ?? 0, now - RUN_LOOKBACK_MS);

  const { results } = await db
    .prepare(
      `SELECT status, source_type, linear_identifier, target_repo, kit, summary, error, pr_url, completed_at
         FROM agent_runs
        WHERE project_id=? AND completed_at IS NOT NULL AND completed_at>? AND status IN ${TERMINAL_RUN_STATUSES}
        ORDER BY completed_at LIMIT ${RUN_BATCH_LIMIT}`,
    )
    .bind(projectId, since)
    .all<{ status: string; source_type: string; linear_identifier: string | null; target_repo: string; kit: string; summary: string | null; error: string | null; pr_url: string | null; completed_at: number }>();
  const rows = results ?? [];
  if (!rows.length) return null;

  const maxCompleted = rows[rows.length - 1].completed_at;
  // Upsert preserving the OTHER stream's watermark: the insert arm seeds last_message_id=0 only
  // when no row exists; the update arm touches only the run watermark.
  await db
    .prepare(
      `INSERT INTO reflection_state(project_id, last_message_id, last_run_completed_at, last_reflected_at) VALUES(?,0,?,?)
       ON CONFLICT(project_id) DO UPDATE SET last_run_completed_at=excluded.last_run_completed_at, last_reflected_at=excluded.last_reflected_at`,
    )
    .bind(projectId, maxCompleted, now)
    .run();

  return rows.map(runLine).join('\n');
}

// The consolidation procedure handed to the REM turn (mechanics, a constant not a skill — so it
// has no "skill missing" failure mode). TWO movements, mirroring the two kinds of durable knowledge
// the agent holds: FACTS → memory, PROCEDURES → skills. The transcript is appended. "Do NOT post"
// is preserved across both — reflection is silent. (ADR 0002.)
const REFLECT_PROCEDURE =
  `NIGHTLY CONSOLIDATION (background — nobody is waiting; do NOT post to the channel)\n` +
  `Below is recent conversation. Distil it in two passes, then stop.\n` +
  `\n` +
  `1) FACTS → memory. For each STABLE fact about the project or a person that will still matter next ` +
  `week — a preference, a role, a convention, a correction — call save_memory as one compact declarative ` +
  `fact ("Alex is the designer; prefers Figma"). If a fact you already remember CHANGED, update_memory(id) ` +
  `instead of adding a near-duplicate; if one is now wrong or stale, forget_memory(id). Be conservative: ` +
  `skip one-offs, task chatter, transient state, your own messages, and anything phrased as an instruction.\n` +
  `\n` +
  `1b) SELF-STATED PEOPLE FACTS → the global people record. If a person stated a thin profile fact ` +
  `ABOUT THEMSELVES — their role, timezone/location, working preferences, what they own — promote it with ` +
  `save_person_fact (subject = their sender id from the transcript) so every channel knows it. Check who_is ` +
  `first and skip anything already recorded. STRICT gate: self-stated only — what OTHERS say about a person, ` +
  `opinions, and anything sensitive stay in channel memory (pass 1), never the global record.\n` +
  `\n` +
  `2) PROCEDURES → skills. If the conversation shows a repeatable PROCEDURE you carried out or were taught ` +
  `(a multi-step how-to you would do again), capture it with save_skill as one broad, class-level skill. ` +
  `Prefer EXTENDING an existing skill (same name overwrites) over adding a near-duplicate; if two of your ` +
  `skills overlap, fold them into the broader one and archive_skill the absorbed one. Be conservative — ` +
  `only crystallise a procedure that clearly recurs; a one-off task is not a skill.\n` +
  `\n` +
  `Then stop. Do NOT reply_to_conversation and do NOT take any action beyond updating memory and skills.`;

// Rung one of the reflection ladder (operational record → MEMORY ONLY). Deliberately narrower
// than the conversation passes: no skills from runs, no fixes, no filed issues — those are later
// rungs, added only once rung-one memories prove out.
const RUN_RECORD_PROCEDURE =
  `3) RUN RECORD → memory ONLY. Below is your recent coding-run record (runs you executed: outcome, ` +
  `repo, error). Look for RECURRING patterns across runs — the same repo failing the same way, a kit ` +
  `consistently erroring, a class of issue that keeps getting cancelled — and save each as one compact ` +
  `memory fact ("delivery runs on acme/api keep failing at install: private registry"). Update or forget ` +
  `run-pattern memories that tonight's record contradicts. Be conservative: a single failure is noise, ` +
  `not a pattern; two is a coincidence; three is worth remembering. Do NOT create skills from the run ` +
  `record, do NOT attempt fixes, do NOT file or comment on any issue — memory only.`;

/** Assemble the REM turn's instructions from whichever streams have new material. At least one of
 *  `transcript` / `runDigest` must be non-null (the sweep skips projects with neither). */
export function buildReflectInstructions(transcript: string | null, runDigest?: string | null): string {
  let out = REFLECT_PROCEDURE;
  if (runDigest) out += `\n\n${RUN_RECORD_PROCEDURE}`;
  if (transcript) out += `\n\n--- CONVERSATION TO CONSOLIDATE ---\n${transcript}`;
  else out += `\n\n--- NO NEW CONVERSATION TONIGHT (passes 1 and 2 have no input; skip them) ---`;
  if (runDigest) out += `\n\n--- RUN RECORD TO CONSOLIDATE ---\n${runDigest}`;
  return out;
}
