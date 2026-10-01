// Proactive review (Layer 4) invariants — run: npx tsx src/review.test.ts

import assert from 'node:assert/strict';
import { createTestRunner, invokeTool } from './shared/test-utils';
import {
  isReviewCandidate,
  isTrivialChatter,
  answerBudgetFree,
  answerBudgetRemaining,
  observationBudgetFree,
  recordProactivePost,
  projectsToReview,
  takeReviewBatch,
  buildReviewInstructions,
  buildOverhearInstructions,
  overheardLine,
  threadTargetFromConversationId,
  proactiveReplyTool,
  ANSWER_BUDGET_PER_DAY,
  OBSERVATION_BUDGET_MS,
  REVIEW_QUIET_MS,
  REVIEW_MAX_WAIT_MS,
} from './review';
import type { D1Like } from './skills/repository';
import type { Binding } from './project/bindings';
import type { ConversationTarget } from './project/conversations';

const { test, run } = createTestRunner();

// ── Heuristic ───────────────────────────────────────────────────────────────────────────────────

test('isReviewCandidate: question shapes pass', () => {
  assert.ok(isReviewCandidate('does anyone know how the deploy pipeline works?'));
  assert.ok(isReviewCandidate('Where do I find the staging credentials'));
  assert.ok(isReviewCandidate('can someone share the runbook for the GCP billing alerts'));
  assert.ok(isReviewCandidate('the build is failing on main, is that known?'));
});

test('isReviewCandidate: chatter, fragments, and person-addressed messages are skipped', () => {
  assert.ok(!isReviewCandidate('thanks!'));
  assert.ok(!isReviewCandidate('lol'));
  assert.ok(!isReviewCandidate('ok?'));
  assert.ok(!isReviewCandidate('<@U123ABC> can you take a look at this when you get a chance?'));
  assert.ok(!isReviewCandidate('shipping the fix now, will update the thread'));
});

test('isTrivialChatter: bare acks/emoji/empty are trivial; substance is not (no question-shape needed)', () => {
  assert.ok(isTrivialChatter(''));
  assert.ok(isTrivialChatter('   '));
  assert.ok(isTrivialChatter('thanks!'));
  assert.ok(isTrivialChatter('👍'));
  assert.ok(isTrivialChatter('lol'));
  // Statements (no '?') are NOT trivial — overhearing judges capability, not grammar.
  assert.ok(!isTrivialChatter('the deploy is broken on main'));
  assert.ok(!isTrivialChatter('delete the Koomi project from Linear'));
});

// ── Overhearing instructions ─────────────────────────────────────────────────────────────────────

test('buildOverhearInstructions: capability-forward framing carries the message + its conversationId', () => {
  const line = overheardLine('slack:T1:C1:9.0', 'U_ALICE', 'can you create a Linear issue for this bug');
  const instr = buildOverhearInstructions(line);
  assert.match(instr, /OVERHEARING/);
  assert.match(instr, /GENUINELY help/);
  assert.match(instr, /proactive_reply/);
  assert.match(instr, /slack:T1:C1:9\.0/);
  assert.match(instr, /U_ALICE: can you create a Linear issue/);
});

// ── Budgets ─────────────────────────────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-06-11T10:00:00Z');

test('answerBudgetRemaining: full when empty/new day, counts down, floors at 0', () => {
  assert.equal(answerBudgetRemaining(null, NOW), ANSWER_BUDGET_PER_DAY);
  assert.equal(answerBudgetRemaining({ answer_posts_today: 99, answer_posts_day: '2026-06-10' }, NOW), ANSWER_BUDGET_PER_DAY);
  assert.equal(answerBudgetRemaining({ answer_posts_today: 2, answer_posts_day: '2026-06-11' }, NOW), ANSWER_BUDGET_PER_DAY - 2);
  assert.equal(answerBudgetRemaining({ answer_posts_today: 99, answer_posts_day: '2026-06-11' }, NOW), 0);
});

test('answerBudgetFree: free when empty, free on a new day, spent at the cap', () => {
  assert.ok(answerBudgetFree(null, NOW));
  assert.ok(answerBudgetFree({ answer_posts_today: ANSWER_BUDGET_PER_DAY, answer_posts_day: '2026-06-10' }, NOW));
  assert.ok(answerBudgetFree({ answer_posts_today: ANSWER_BUDGET_PER_DAY - 1, answer_posts_day: '2026-06-11' }, NOW));
  assert.ok(!answerBudgetFree({ answer_posts_today: ANSWER_BUDGET_PER_DAY, answer_posts_day: '2026-06-11' }, NOW));
});

test('observationBudgetFree: free when never posted or >24h ago', () => {
  assert.ok(observationBudgetFree(null, NOW));
  assert.ok(observationBudgetFree({ last_observation_post_at: NOW - OBSERVATION_BUDGET_MS - 1 }, NOW));
  assert.ok(!observationBudgetFree({ last_observation_post_at: NOW - 60_000 }, NOW));
});

// ── FakeD1 for the gate/batch/budget SQL ────────────────────────────────────────────────────────

interface MsgRow {
  id: number;
  project_id: string;
  conversation_id: string;
  sender_id: string;
  role: string;
  text: string;
  review_candidate: number;
  created_at: number;
}
interface StateRow {
  project_id: string;
  last_reviewed_message_id: number;
  last_observation_post_at: number | null;
  answer_posts_today: number;
  answer_posts_day: string | null;
}

class FakeD1 implements D1Like {
  messages: MsgRow[] = [];
  state = new Map<string, StateRow>();
  private nextId = 1;

  add(projectId: string, text: string, opts: { candidate?: boolean; at?: number; conv?: string } = {}): void {
    this.messages.push({
      id: this.nextId++,
      project_id: projectId,
      conversation_id: opts.conv ?? `slack:T1:C1:${this.nextId}.0`,
      sender_id: 'slack:T1:U1',
      role: 'user',
      text,
      review_candidate: opts.candidate ? 1 : 0,
      created_at: opts.at ?? NOW,
    });
  }

  stateFor(projectId: string): StateRow {
    let s = this.state.get(projectId);
    if (!s) {
      s = { project_id: projectId, last_reviewed_message_id: 0, last_observation_post_at: null, answer_posts_today: 0, answer_posts_day: null };
      this.state.set(projectId, s);
    }
    return s;
  }

  prepare(query: string) {
    const self = this;
    return {
      bind(...values: unknown[]) {
        return {
          async run(): Promise<unknown> {
            if (query.includes('INSERT INTO review_state') && query.includes('last_reviewed_message_id')) {
              const [projectId, maxId] = values as [string, number];
              self.stateFor(projectId).last_reviewed_message_id = maxId;
              return {};
            }
            if (query.includes('INSERT INTO review_state') && query.includes('last_observation_post_at')) {
              const [projectId, at] = values as [string, number];
              self.stateFor(projectId).last_observation_post_at = at;
              return {};
            }
            if (query.includes('INSERT INTO review_state') && query.includes('answer_posts_today')) {
              const [projectId, day] = values as [string, string];
              const s = self.stateFor(projectId);
              s.answer_posts_today = s.answer_posts_day === day ? s.answer_posts_today + 1 : 1;
              s.answer_posts_day = day;
              return {};
            }
            throw new Error(`unexpected run: ${query}`);
          },
          async all<T>(): Promise<{ results: T[] }> {
            if (query.includes('GROUP BY m.project_id')) {
              const byProject = new Map<string, MsgRow[]>();
              for (const m of self.messages) {
                const list = byProject.get(m.project_id) ?? [];
                list.push(m);
                byProject.set(m.project_id, list);
              }
              const rows = [...byProject.entries()].map(([pid, msgs]) => {
                const st = self.state.get(pid);
                const wm = st?.last_reviewed_message_id ?? 0;
                const cands = msgs.filter((m) => m.review_candidate === 1 && m.id > wm);
                return {
                  project_id: pid,
                  candidates: cands.length,
                  oldest_candidate_at: cands.length ? Math.min(...cands.map((m) => m.created_at)) : null,
                  last_message_at: msgs.length ? Math.max(...msgs.map((m) => m.created_at)) : null,
                  last_observation_post_at: st?.last_observation_post_at ?? null,
                  answer_posts_today: st?.answer_posts_today ?? null,
                  answer_posts_day: st?.answer_posts_day ?? null,
                } as T;
              });
              return { results: rows };
            }
            if (query.includes('FROM messages') && query.includes('ORDER BY id')) {
              const [projectId, since] = values as [string, number];
              return {
                results: self.messages
                  .filter((m) => m.project_id === projectId && m.id > since)
                  .sort((a, b) => a.id - b.id) as unknown as T[],
              };
            }
            throw new Error(`unexpected all: ${query}`);
          },
          async first<T = Record<string, unknown>>(): Promise<T | null> {
            if (query.includes('FROM review_state')) {
              const [projectId] = values as [string];
              return (self.state.get(projectId) as T) ?? null;
            }
            throw new Error(`unexpected first: ${query}`);
          },
        };
      },
    };
  }
}

// ── Gate ────────────────────────────────────────────────────────────────────────────────────────

test('projectsToReview: quiet channel with an unreviewed candidate qualifies; no candidates → skip', async () => {
  const db = new FakeD1();
  db.add('P1', 'does anyone know where the runbook is?', { candidate: true, at: NOW - REVIEW_QUIET_MS - 1000 });
  db.add('P2', 'shipping now', { at: NOW - REVIEW_QUIET_MS - 1000 });
  assert.deepEqual(await projectsToReview(db, { now: NOW }), ['P1']);
});

test('projectsToReview: busy channel waits (debounce) until max-wait forces it through', async () => {
  const db = new FakeD1();
  db.add('P1', 'how do I rotate the API key?', { candidate: true, at: NOW - 2 * 60_000 });
  db.add('P1', 'still chatting', { at: NOW - 10_000 }); // channel NOT quiet
  assert.deepEqual(await projectsToReview(db, { now: NOW }), [], 'debounced while the room is talking');

  const later = NOW + REVIEW_MAX_WAIT_MS;
  db.add('P1', 'more chatter', { at: later - 5_000 }); // still not quiet…
  assert.deepEqual(await projectsToReview(db, { now: later }), ['P1'], '…but the old candidate forces a review');
});

test('projectsToReview: skips when BOTH budgets are spent', async () => {
  const db = new FakeD1();
  db.add('P1', 'is the deploy stuck?', { candidate: true, at: NOW - REVIEW_QUIET_MS - 1000 });
  const s = db.stateFor('P1');
  s.answer_posts_today = ANSWER_BUDGET_PER_DAY;
  s.answer_posts_day = '2026-06-11';
  s.last_observation_post_at = NOW - 60_000;
  assert.deepEqual(await projectsToReview(db, { now: NOW }), []);
});

// ── Batch ───────────────────────────────────────────────────────────────────────────────────────

test('takeReviewBatch: includes ambient rows, marks candidates, advances the watermark', async () => {
  const db = new FakeD1();
  db.add('P1', 'morning all', { conv: 'slack:T1:C1:1.0' });
  db.add('P1', 'where are the staging creds?', { candidate: true, conv: 'slack:T1:C1:2.0' });
  const batch = await takeReviewBatch(db, 'P1');
  assert.ok(batch);
  assert.match(batch!, /\(slack:T1:C1:2\.0\) slack:T1:U1: where are the staging creds\? \[question\?\]/);
  assert.match(batch!, /morning all/);
  assert.equal(db.stateFor('P1').last_reviewed_message_id, 2);
  assert.equal(await takeReviewBatch(db, 'P1'), null, 'consumed — second take is empty');
});

test('buildReviewInstructions: silence-first procedure wraps the batch', () => {
  const out = buildReviewInstructions('(c1) someone: hi');
  assert.match(out, /stay SILENT/);
  assert.match(out, /proactive_reply/);
  assert.match(out, /\(c1\) someone: hi/);
});

// ── proactive_reply ─────────────────────────────────────────────────────────────────────────────

const BINDING = {
  provider: 'slack',
  externalAccountId: 'T1',
  externalSpaceId: 'C1',
  transportBotId: 'UBOT',
  projectId: 'P1',
  sandboxMode: 'virtual',
  transportTokenRef: 'SLACK_TOKEN',
  status: 'active',
} as unknown as Binding;

test('threadTargetFromConversationId: builds a threaded target; refuses other channels', () => {
  const t = threadTargetFromConversationId(BINDING, 'slack:T1:C1:123.456');
  assert.equal(t?.externalConversationId, '123.456');
  assert.equal(t?.externalSpaceId, 'C1');
  assert.equal(threadTargetFromConversationId(BINDING, 'slack:T1:C_OTHER:123.456'), null);
  assert.equal(threadTargetFromConversationId(BINDING, 'garbage'), null);
});

function makeTool(db: FakeD1, mode: string | undefined, sent: Array<{ target: ConversationTarget; text: string }>, logs: string[] = []) {
  return proactiveReplyTool({
    db,
    projectId: 'P1',
    binding: BINDING,
    mode,
    send: async (target, text) => {
      sent.push({ target, text });
    },
    log: (m) => logs.push(m),
    now: () => NOW,
  });
}

test('proactive_reply: shadow mode logs the draft, posts nothing, spends no budget', async () => {
  const db = new FakeD1();
  const sent: Array<{ target: ConversationTarget; text: string }> = [];
  const logs: string[] = [];
  const tool = makeTool(db, undefined, sent, logs);
  const out = await invokeTool(tool, { conversationId: 'slack:T1:C1:9.0', kind: 'answer', text: 'the runbook is at /docs' });
  assert.match(String(out), /shadow/);
  assert.equal(sent.length, 0);
  assert.equal(db.state.get('P1'), undefined);
  assert.ok(logs.some((l) => l.includes('[review-draft]')));
});

test('proactive_reply: live mode posts into the thread and consumes the right budget', async () => {
  const db = new FakeD1();
  const sent: Array<{ target: ConversationTarget; text: string }> = [];
  const tool = makeTool(db, 'live', sent);
  await invokeTool(tool, { conversationId: 'slack:T1:C1:9.0', kind: 'answer', text: 'answer + receipt' });
  assert.equal(sent[0].target.externalConversationId, '9.0');
  assert.equal(db.stateFor('P1').answer_posts_today, 1);
  assert.equal(db.stateFor('P1').last_observation_post_at, null, 'answer budget consumed, not observation');

  await invokeTool(tool, { conversationId: 'slack:T1:C1:9.0', kind: 'observation', text: 'related thread' });
  assert.equal(db.stateFor('P1').last_observation_post_at, NOW);
});

test('proactive_reply: the budget-spending reply tacks on a quiet "last for today" heads-up', async () => {
  const db = new FakeD1();
  const s = db.stateFor('P1');
  s.answer_posts_today = ANSWER_BUDGET_PER_DAY - 1; // this post spends the last unit
  s.answer_posts_day = '2026-06-11';
  const sent: Array<{ target: ConversationTarget; text: string }> = [];
  const tool = makeTool(db, 'live', sent);
  await invokeTool(tool, { conversationId: 'slack:T1:C1:9.0', kind: 'answer', text: 'the runbook is at /docs' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /the runbook is at \/docs/);
  assert.match(sent[0].text, /last unprompted reply for today/);
  assert.match(sent[0].text, /@mention me/);
});

test('proactive_reply: a non-final reply carries no heads-up', async () => {
  const db = new FakeD1();
  const sent: Array<{ target: ConversationTarget; text: string }> = [];
  const tool = makeTool(db, 'live', sent); // empty budget state → plenty remaining
  await invokeTool(tool, { conversationId: 'slack:T1:C1:9.0', kind: 'answer', text: 'plain answer' });
  assert.equal(sent[0].text, 'plain answer');
});

test('proactive_reply: refuses when the budget is spent', async () => {
  const db = new FakeD1();
  const s = db.stateFor('P1');
  s.answer_posts_today = ANSWER_BUDGET_PER_DAY;
  s.answer_posts_day = '2026-06-11';
  const sent: Array<{ target: ConversationTarget; text: string }> = [];
  const tool = makeTool(db, 'live', sent);
  const out = await invokeTool(tool, { conversationId: 'slack:T1:C1:9.0', kind: 'answer', text: 'x'.repeat(20) });
  assert.match(String(out), /budget.*spent/);
  assert.equal(sent.length, 0);
});

test('proactive_reply: refuses a conversationId outside this channel', async () => {
  const db = new FakeD1();
  const tool = makeTool(db, 'live', []);
  await assert.rejects(() => invokeTool(tool, { conversationId: 'slack:T1:C_EVIL:9.0', kind: 'answer', text: 'leak attempt' }), /does not belong/);
});

void run();
