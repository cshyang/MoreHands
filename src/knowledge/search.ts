// Cross-thread Connect + catch-up (Layer 3): find prior threads in a channel by querying the
// ingested transcript. Agent-PULL — exposed as a tool the model calls when a topic might have come
// up before, or to catch up on recent channel activity. No index: queries the `messages` table
// Phase 2 already fills (ambient rows included).
//
// Two modes, one tool: a keyword query → topical search (Connect); no query → most recent threads
// (catch-up). Recall is keyword-blunt by design; PRECISION is the model's job — it receives candidate
// threads and cites one ONLY if clearly relevant. The query is tokenized to alphanumeric terms, which
// removes stopword noise and neutralizes SQL-LIKE wildcard/operator injection (a term can never carry
// %, _, or a quote), so the `%term%` patterns are always safe to bind.

import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { D1Like } from '../skills/repository';

const RAW_LIMIT = 200; // cap rows pulled for in-JS grouping; a single channel won't exceed this for a real query
const MAX_THREADS = 4; // candidate threads handed to the model
const SNIPPET_MAX = 160;
const MIN_TERM_LEN = 2;

export interface RelatedThread {
  conversationId: string;
  channel: string | null;
  threadTs: string | null;
  snippet: string;
  when: string; // YYYY-MM-DD of the representative message
  score: number; // distinct query-terms matched across the thread (0 in recency mode)
}

/** Tokenize a free-text query into lowercase alphanumeric terms. Drops punctuation (so a term can
 *  never carry a LIKE wildcard or quote), short tokens, and duplicates. Empty array → caller returns
 *  no results rather than running a query that would match everything. */
export function buildSearchTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const tok of String(query ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (tok.length >= MIN_TERM_LEN) seen.add(tok);
  }
  return [...seen];
}

/** Split a MoreHands conversationId ("slack:<team>:<channel>:<thread_ts>") into its parts, or null. */
export function parseConversationId(cid: string): { team: string; channel: string; threadTs: string } | null {
  const m = String(cid ?? '').match(/^slack:([^:]+):([^:]+):(.+)$/);
  return m ? { team: m[1], channel: m[2], threadTs: m[3] } : null;
}

function truncate(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= SNIPPET_MAX ? t : t.slice(0, SNIPPET_MAX - 1) + '…';
}

/** Build a RelatedThread from a representative message (the matched/newest one in the thread). */
function toThread(conversationId: string, text: string, createdAt: number, score: number): RelatedThread {
  const parts = parseConversationId(conversationId);
  return {
    conversationId,
    channel: parts?.channel ?? null,
    threadTs: parts?.threadTs ?? null,
    snippet: truncate(text),
    when: new Date(createdAt).toISOString().slice(0, 10),
    score,
  };
}

/** Search the transcript for prior threads matching `query`, scoped to `projectId`. Returns up to
 *  MAX_THREADS candidate threads ranked by how many distinct query terms they contain, then recency.
 *  Empty query or no matches → []. The current thread can be excluded via opts.excludeConversationId. */
export async function searchRelatedThreads(
  db: D1Like,
  projectId: string,
  query: string,
  opts: { excludeConversationId?: string } = {},
): Promise<RelatedThread[]> {
  const terms = buildSearchTerms(query);
  if (!terms.length) return [];

  const ors = terms.map(() => 'text LIKE ?').join(' OR ');
  const { results } = await db
    .prepare(
      `SELECT conversation_id, text, created_at FROM messages
        WHERE project_id = ? AND conversation_id != ? AND (${ors})
        ORDER BY created_at DESC LIMIT ${RAW_LIMIT}`,
    )
    .bind(projectId, opts.excludeConversationId ?? '', ...terms.map((t) => `%${t}%`))
    .all<{ conversation_id: string; text: string; created_at: number }>();

  // Group matching messages into threads; score each thread by distinct query-terms it covers, and
  // keep the single best-covering message as the snippet (tie → most recent).
  const byThread = new Map<string, { matched: Set<string>; best: { text: string; created_at: number; hits: number } }>();
  for (const r of results ?? []) {
    const lc = r.text.toLowerCase();
    const hits = terms.filter((t) => lc.includes(t));
    if (!hits.length) continue;
    const entry = byThread.get(r.conversation_id) ?? { matched: new Set<string>(), best: { text: '', created_at: -1, hits: -1 } };
    hits.forEach((t) => entry.matched.add(t));
    if (hits.length > entry.best.hits || (hits.length === entry.best.hits && r.created_at > entry.best.created_at)) {
      entry.best = { text: r.text, created_at: r.created_at, hits: hits.length };
    }
    byThread.set(r.conversation_id, entry);
  }

  return [...byThread.entries()]
    .map(([conversationId, e]) => ({ thread: toThread(conversationId, e.best.text, e.best.created_at, e.matched.size), at: e.best.created_at }))
    .sort((a, b) => b.thread.score - a.thread.score || b.at - a.at)
    .slice(0, MAX_THREADS)
    .map((x) => x.thread);
}

/** Recency mode (catch-up): the most recent threads in the channel, regardless of topic — the
 *  newest message per thread is the snippet. Powers `search_channel` when called with no query. */
export async function recentThreads(
  db: D1Like,
  projectId: string,
  opts: { excludeConversationId?: string } = {},
): Promise<RelatedThread[]> {
  const { results } = await db
    .prepare(
      `SELECT conversation_id, text, created_at FROM messages
        WHERE project_id = ? AND conversation_id != ?
        ORDER BY created_at DESC LIMIT ${RAW_LIMIT}`,
    )
    .bind(projectId, opts.excludeConversationId ?? '')
    .all<{ conversation_id: string; text: string; created_at: number }>();

  // Rows arrive newest-first; the first time we see a thread is its newest message → the snippet.
  const seen = new Map<string, { text: string; created_at: number }>();
  for (const r of results ?? []) {
    if (!seen.has(r.conversation_id)) seen.set(r.conversation_id, { text: r.text, created_at: r.created_at });
  }
  return [...seen.entries()]
    .sort((a, b) => b[1].created_at - a[1].created_at)
    .slice(0, MAX_THREADS)
    .map(([conversationId, m]) => toThread(conversationId, m.text, m.created_at, 0));
}

/** Render candidate threads as a compact block the model reads. No permalinks in v1 — the model
 *  references a thread by its snippet/date; clickable cites (chat.getPermalink) are a fast-follow.
 *  The header differs by mode so the model knows whether these are topical matches (cite with care)
 *  or just a recency dump (catch-up). */
function renderThreads(threads: RelatedThread[], mode: 'search' | 'recent'): string {
  if (!threads.length) {
    return mode === 'recent' ? 'No recent activity in this channel.' : 'No earlier threads found about that.';
  }
  const header =
    mode === 'recent'
      ? 'Recent threads in this channel (most recent first):'
      : 'Possibly related earlier threads (cite ONLY if clearly the same topic):';
  const lines = threads.map((t, i) => `${i + 1}. (${t.when}) "${t.snippet}"`);
  return `${header}\n${lines.join('\n')}`;
}

/** The on-demand channel-memory tool. Closed over db + projectId (bound at DO-init, so it's
 *  dispatch-safe and can never reach another project). Two modes: a `query` runs a topical search
 *  (Connect); omitting `query` returns recent activity (catch-up). Optionally pass the current
 *  conversationId so the thread the agent is in is excluded. */
export function searchTools(db: D1Like | undefined, projectId: string): ToolDefinition[] {
  if (!db) return [];
  const searchChannel = defineTool({
    name: 'search_channel',
    description:
      "Look into THIS channel's earlier conversations. Pass `query` with a few keywords to check " +
      'whether a topic has come up before — the result is candidate threads; mention one to the ' +
      'person ONLY if it is clearly about the same thing, and if nothing fits, do not force a ' +
      'connection. OMIT `query` to instead get the most recent threads, to catch up on what has been ' +
      'happening in the channel. Optionally pass `excludeConversationId` (your current conversationId ' +
      'from the dispatch input) to skip the thread you are replying in.',
    input: v.object({
      query: v.optional(v.pipe(v.string(), v.description('A few topic keywords, e.g. "pricing model". OMIT to list recent activity instead.'))),
      excludeConversationId: v.optional(v.pipe(v.string(), v.description('Your current conversationId from the dispatch input, to skip this thread.'))),
    }),
    async run({ data: { query, excludeConversationId } }) {
      const exclude = excludeConversationId ? String(excludeConversationId) : undefined;
      const q = query ? String(query).trim() : '';
      const threads = q
        ? await searchRelatedThreads(db, projectId, q, { excludeConversationId: exclude }).catch(() => [] as RelatedThread[])
        : await recentThreads(db, projectId, { excludeConversationId: exclude }).catch(() => [] as RelatedThread[]);
      return renderThreads(threads, q ? 'search' : 'recent');
    },
  });
  return [searchChannel];
}
