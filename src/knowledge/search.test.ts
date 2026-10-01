// Cross-thread Connect + catch-up retrieval — run: npx tsx src/knowledge/search.test.ts
import assert from 'node:assert/strict';
import { createTestRunner, invokeTool } from '../shared/test-utils';
import { buildSearchTerms, parseConversationId, searchRelatedThreads, recentThreads } from './search';
import type { D1Like } from '../skills/repository';

const { test, run } = createTestRunner();

// ── helper unit tests ───────────────────────────────────────────────────────
test('buildSearchTerms: lowercases, drops punctuation/short tokens, dedupes', async () => {
  assert.deepEqual(buildSearchTerms('Pricing model?'), ['pricing', 'model']);
  // wildcard / operator chars are stripped to alphanumerics → no LIKE injection
  assert.deepEqual(buildSearchTerms('50% OR _x_ "quote"'), ['50', 'or', 'quote']);
  assert.deepEqual(buildSearchTerms('a bb ccc'), ['bb', 'ccc']); // single-char tokens dropped (<2)
  assert.deepEqual(buildSearchTerms('pricing pricing PRICING'), ['pricing']); // dedupe
});

test('parseConversationId: splits slack:team:channel:thread, null on garbage', async () => {
  assert.deepEqual(parseConversationId('slack:T1:C9:170.5'), { team: 'T1', channel: 'C9', threadTs: '170.5' });
  assert.equal(parseConversationId('nonsense'), null);
});

// ── retrieval tests (FakeD1) ─────────────────────────────────────────────────
interface Row { project_id: string; conversation_id: string; text: string; created_at: number; }
// Minimal D1 fake for the search/recency queries: substring-matches each `%term%` bind (LIKE is
// case-insensitive ASCII; we lowercase both sides). Binds: [projectId, excludeId, ...patterns].
class FakeD1 implements D1Like {
  constructor(private rows: Row[]) {}
  prepare(query: string) {
    const rows = this.rows;
    return {
      bind(...v: unknown[]) {
        return {
          async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
            if (!query.includes('FROM messages')) return { results: [] as T[] };
            const [projectId, excludeId, ...patterns] = v as string[];
            const terms = patterns.map((p) => p.replace(/%/g, '').toLowerCase());
            const limit = Number((query.match(/LIMIT (\d+)/) ?? [])[1] ?? 1e9);
            const out = rows
              .filter((r) => r.project_id === projectId)
              .filter((r) => r.conversation_id !== excludeId)
              // no patterns = recency mode (recentThreads) → match all; else keyword OR-match
              .filter((r) => terms.length === 0 || terms.some((t) => r.text.toLowerCase().includes(t)))
              .sort((a, b) => b.created_at - a.created_at)
              .slice(0, limit)
              .map((r) => ({ conversation_id: r.conversation_id, text: r.text, created_at: r.created_at }));
            return { results: out as T[] };
          },
          async run() { return {}; },
          async first<T = Record<string, unknown>>() { return null as T | null; },
        };
      },
    };
  }
}

const mk = (rows: Partial<Row>[]): FakeD1 =>
  new FakeD1(rows.map((r, i) => ({ project_id: 'P', conversation_id: 'slack:T:C:t' + i, text: '', created_at: i, ...r })));

test('finds a thread containing the query terms; returns snippet + conversationId', async () => {
  const db = mk([{ conversation_id: 'slack:T:C:t1', text: 'can we change the pricing model?' }]);
  const out = await searchRelatedThreads(db, 'P', 'pricing');
  assert.equal(out.length, 1);
  assert.equal(out[0].conversationId, 'slack:T:C:t1');
  assert.match(out[0].snippet, /pricing model/);
});

test('groups multiple matching messages in one thread into a single result', async () => {
  const db = mk([
    { conversation_id: 'slack:T:C:tA', text: 'pricing is too high', created_at: 1 },
    { conversation_id: 'slack:T:C:tA', text: 'agreed, the pricing tiers need work', created_at: 2 },
  ]);
  const out = await searchRelatedThreads(db, 'P', 'pricing');
  assert.equal(out.length, 1, 'two messages, one thread → one result');
});

test('ranks a thread matching MORE query terms above one matching fewer', async () => {
  const db = mk([
    { conversation_id: 'slack:T:C:tWeak', text: 'pricing only', created_at: 5 },
    { conversation_id: 'slack:T:C:tStrong', text: 'the pricing model and tiers', created_at: 1 },
  ]);
  const out = await searchRelatedThreads(db, 'P', 'pricing model tiers');
  assert.equal(out[0].conversationId, 'slack:T:C:tStrong', 'more-terms thread ranks first despite being older');
});

test('excludes the current conversation', async () => {
  const db = mk([
    { conversation_id: 'slack:T:C:here', text: 'pricing now' },
    { conversation_id: 'slack:T:C:there', text: 'pricing earlier' },
  ]);
  const out = await searchRelatedThreads(db, 'P', 'pricing', { excludeConversationId: 'slack:T:C:here' });
  assert.deepEqual(out.map((r) => r.conversationId), ['slack:T:C:there']);
});

test('scopes to the project (no cross-project leakage)', async () => {
  const db = mk([
    { project_id: 'P', conversation_id: 'slack:T:C:mine', text: 'pricing mine' },
    { project_id: 'OTHER', conversation_id: 'slack:T:D:theirs', text: 'pricing theirs' },
  ]);
  const out = await searchRelatedThreads(db, 'P', 'pricing');
  assert.deepEqual(out.map((r) => r.conversationId), ['slack:T:C:mine']);
});

test('NEGATIVE: a never-discussed topic returns nothing (no candidate to over-connect)', async () => {
  const db = mk([{ conversation_id: 'slack:T:C:t1', text: 'lunch plans for friday' }]);
  assert.deepEqual(await searchRelatedThreads(db, 'P', 'kubernetes migration'), []);
});

test('NEGATIVE: an empty/punctuation-only query returns nothing (never matches all rows)', async () => {
  const db = mk([{ conversation_id: 'slack:T:C:t1', text: 'anything' }]);
  assert.deepEqual(await searchRelatedThreads(db, 'P', '   ?!  '), []);
});

// ── recency mode (catch-up) ──────────────────────────────────────────────────
test('recentThreads: returns latest threads, newest first, one per thread', async () => {
  const db = mk([
    { conversation_id: 'slack:T:C:old', text: 'old stuff', created_at: 1 },
    { conversation_id: 'slack:T:C:new', text: 'newest stuff', created_at: 9 },
    { conversation_id: 'slack:T:C:new', text: 'older in new thread', created_at: 8 },
  ]);
  const out = await recentThreads(db, 'P');
  assert.deepEqual(out.map((r) => r.conversationId), ['slack:T:C:new', 'slack:T:C:old']);
  assert.match(out[0].snippet, /newest stuff/); // newest message in the thread is the snippet
});

test('recentThreads: excludes the current conversation', async () => {
  const db = mk([
    { conversation_id: 'slack:T:C:here', text: 'in here', created_at: 9 },
    { conversation_id: 'slack:T:C:there', text: 'over there', created_at: 1 },
  ]);
  const out = await recentThreads(db, 'P', { excludeConversationId: 'slack:T:C:here' });
  assert.deepEqual(out.map((r) => r.conversationId), ['slack:T:C:there']);
});

test('recentThreads: empty channel → []', async () => {
  assert.deepEqual(await recentThreads(mk([]), 'P'), []);
});

// ── tool surface ─────────────────────────────────────────────────────────────
const callTool = invokeTool;

test('searchTools: exposes exactly search_channel', async () => {
  const { searchTools } = await import('./search');
  const tools = searchTools(mk([]), 'P');
  assert.deepEqual(tools.map((t) => t.name as string), ['search_channel']);
});

test('search_channel: formats found threads with snippet + date', async () => {
  const { searchTools } = await import('./search');
  const db = mk([{ conversation_id: 'slack:T:C:t1', text: 'we discussed the pricing model here', created_at: 1700000000000 }]);
  const [tool] = searchTools(db, 'P');
  const out = String(await callTool(tool, { query: 'pricing model' }));
  assert.match(out, /pricing model/);
  assert.match(out, /2023-11-14/); // date rendered from created_at
});

test('search_channel: a never-discussed topic returns a clear "nothing found" (no fabrication)', async () => {
  const { searchTools } = await import('./search');
  const db = mk([{ conversation_id: 'slack:T:C:t1', text: 'lunch plans' }]);
  const [tool] = searchTools(db, 'P');
  const out = String(await callTool(tool, { query: 'kubernetes' }));
  assert.match(out, /no earlier|nothing/i);
});

test('search_channel: no query → recent activity (catch-up mode)', async () => {
  const { searchTools } = await import('./search');
  const db = mk([{ conversation_id: 'slack:T:C:t1', text: 'latest channel chatter', created_at: 1700000000000 }]);
  const [tool] = searchTools(db, 'P');
  const out = String(await callTool(tool, {}));
  assert.match(out, /recent/i);
  assert.match(out, /latest channel chatter/);
});

await run();
