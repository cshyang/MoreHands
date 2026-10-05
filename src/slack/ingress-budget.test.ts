import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { ingressDbFixture } from './test-utils/ingress-db';
import { withIngressBudget, ingressBudget, remainingIngressBudget, reserveIngressBudget, IngressBudgetDeferred } from './ingress-budget';
import { reconcileAgentRuns } from '../agent-runs/dispatch';
const { test, run } = createTestRunner();

test('reservations protect a complete operation from concurrent spend and return unused slots', async () => {
  const f = ingressDbFixture();
  try {
    const db = withIngressBudget({ DB: f.db }, 5).DB;
    const a = reserveIngressBudget(db, 3)!;
    const b = reserveIngressBudget(db, 2)!;
    assert.equal(reserveIngressBudget(db, 1), null);
    assert.equal(remainingIngressBudget(db), 0);
    await assert.rejects(async () => db.prepare('SELECT 1').bind().first(), IngressBudgetDeferred);
    await a.db.prepare('SELECT 1').bind().first();
    await b.db.prepare('SELECT 1').bind().first();
    b.release(); a.release();
    assert.equal(ingressBudget(db)!.used, 2); assert.equal(ingressBudget(db)!.reserved, 0);
    assert.equal(remainingIngressBudget(db), 3);
    await assert.rejects(async () => a.db.prepare('SELECT 1').bind().first(), IngressBudgetDeferred);
  } finally { f.dispose(); }
});
test('nested reservations and transactional batches count each platform statement once', async () => {
  const f = ingressDbFixture();
  try {
    const db = withIngressBudget({ DB: f.db }, 5).DB;
    const phase = reserveIngressBudget(db, 4)!;
    const operation = reserveIngressBudget(phase.db, 3)!;
    assert.equal(remainingIngressBudget(phase.db), 1);
    await operation.db.batch([
      operation.db.prepare('SELECT 1').bind(), operation.db.prepare('SELECT 2').bind(),
    ]);
    assert.equal(ingressBudget(db)!.used, 2);
    operation.release(); assert.equal(remainingIngressBudget(phase.db), 2);
    phase.release(); assert.equal(remainingIngressBudget(db), 3);
    assert.equal(ingressBudget(db)!.reserved, 0);
  } finally { f.dispose(); }
});
test('the hard backstop refuses the fifty-first query before issuing it', async () => {
  const f = ingressDbFixture();
  try {
    const db = withIngressBudget({ DB: f.db }).DB;
    for (let i = 0; i < 50; i++) await db.prepare('SELECT 1').bind().first();
    await assert.rejects(async () => db.prepare('SELECT 1').bind().first(), IngressBudgetDeferred);
    assert.equal(ingressBudget(db)!.used, 50);
  } finally { f.dispose(); }
});
test('parallel coding claims hold independent resolver and outcome/readback allocations', async () => {
  const f = ingressDbFixture();
  try {
    for (let i = 0; i < 10; i++) f.sql.prepare(`INSERT INTO agent_runs(id,project_id,source_type,idempotency_key,target_repo,
      status,dispatch_payload,created_at,updated_at) VALUES(?,'P','internal',?,'example/repo','queued',?,0,0)`)
      .run(`R${i}`, `R${i}`, JSON.stringify({ targetRepo:'example/repo', baseBranch:'main', kit:'coding-default', runtime:'pi', sandboxProvider:'e2b' }));
    const original = f.db.prepare.bind(f.db); let lost = false;
    f.db.prepare = query => ({ bind: (...values) => {
      const actual = original(query).bind(...values);
      return { ...actual, first: async <T>() => {
        const result = await actual.first<T>();
        if (!lost && query.includes('FROM agent_runs WHERE id=') && (result as { status?: string } | null)?.status === 'running') {
          lost = true; throw new Error('lost success readback');
        }
        return result;
      } };
    } });
    const db = withIngressBudget({ DB: f.db }).DB;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let started = 0;
    const task = reconcileAgentRuns(db, { triggerApiUrl:'https://fixture.invalid',triggerSecretKey:'fixture',runnerToken:'fixture',
      moreHandsPublicUrl:'https://fixture.invalid',resolveGithubToken: async (_run, operationDb) => {
        assert.ok(operationDb); await operationDb.prepare('SELECT 1').bind().first();
        await operationDb.prepare('SELECT 1').bind().first(); return 'fixture';
      }, fetch: async () => { started++; await gate; return Response.json({ id:'fixture' }); } });
    for (let i = 0; i < 100 && started < 4; i++) await new Promise(resolve => setImmediate(resolve));
    release(); const summary = await task;
    assert.equal(started, 4); assert.equal(lost, true); assert.equal(summary.dispatched, 3);
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE status='queued'").get()!.n, 7);
    assert.equal(ingressBudget(db)!.used, 34); // 3 enumeration + 3*7 success + 10 lost-success continuation
    assert.equal(ingressBudget(db)!.reserved, 0);
  } finally { f.dispose(); }
});
await run();
