import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createTestRunner } from '../shared/test-utils';
import { ingressFixture } from './ingress-test-fixture';
import { deferred } from './test-fixtures';
import * as admissions from './admissions';
import * as producers from './producer';
import * as reminders from '../gateway/reminders-store';
import * as ingressBudget from '../slack/ingress-budget';
import { slackMessage } from './ingress-test-fixture';
import type { BoundD1Statement, IngressDb } from '../slack/ingress-store';

const { test, run } = createTestRunner();
async function cronFixture(state: 'open' | 'closed') {
  const f = await ingressFixture(state);
  f.sql.exec(`INSERT INTO reminders(id,project_id,next_run,payload,created_at,updated_at)
    VALUES('job','P',1,'{"prompt":"Check project"}',0,0)`);
  const jobs: Promise<unknown>[] = [];
  const scanStarted = deferred<void>();
  const resumeScan = deferred<void>();
  let hold = false;
  let takeDueCalls = 0;
  const routes: string[] = [];
  const exported: Record<string, any> = {};
  const source = readFileSync(new URL('../cloudflare.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const scheduledModule = f.scheduledHelper;
  runInNewContext(output, {
    exports: exported,
    require: (name: string) => {
      if (name === './slack/ingress-budget') return ingressBudget;
      if (name === './app') return { __esModule: true, default: { fetch: (...args: any[]) => {
        routes.push(new URL(args[0].url).pathname); return f.app.fetch(...args);
      } } };
      if (name === './cutover/admissions') return admissions;
      if (name === './cutover/producer') return producers;
      if (name === './gateway/scheduled-dispatch') return scheduledModule;
      if (name === './gateway/reminders-store') return { takeDueReminders: async (db: Parameters<typeof reminders.takeDueReminders>[0]) => {
        takeDueCalls++; scanStarted.resolve();
        if (hold) await resumeScan.promise;
        return reminders.takeDueReminders(db);
      } };
      if (name === 'cloudflare:workers') return { DurableObject: class {} };
      if (name === '@cloudflare/sandbox') return { Sandbox: class {} };
      throw new Error(`unexpected wrapper import: ${name}`);
    }, Request, Response, crypto, console: { log() {} },
  });
  return { ...f, scanStarted, resumeScan,
    holdScan: () => { hold = true; },
    calls: () => takeDueCalls,
    routes,
    fire: (cron: string, env: unknown = f.env, scheduledTime = 0) => exported.default.scheduled({ cron, scheduledTime }, env, {
      waitUntil: (job: Promise<unknown>) => jobs.push(job),
    }),
    finish: async () => { while (jobs.length) await Promise.all(jobs.splice(0)); await f.finishJobs(); },
  };
}
function hardBinding(original: IngressDb) {
  const statements = new WeakMap<object, BoundD1Statement>();
  let issued = 0, refused = 0;
  const charge = (n = 1) => {
    if (issued + n > 50) { refused++; throw new Error('fixture hard D1 limit at statement 51'); }
    issued += n;
  };
  const db: IngressDb = {
    prepare: query => ({ bind: (...values) => {
      const actual = original.prepare(query).bind(...values);
      const wrapped = { run: () => { charge(); return actual.run(); },
        first: <T>() => { charge(); return actual.first<T>(); }, all: <T>() => { charge(); return actual.all<T>(); } };
      statements.set(wrapped, actual); return wrapped;
    } }),
    batch: values => { charge(values.length); return original.batch(values.map(s => statements.get(s) ?? s)); },
  };
  return { db, issued: () => issued, refused: () => refused };
}
// A gate after takeDueReminders loses one-shots; a second intake gate loses admitted scans at closure.
test('closed reminder cron leaves the real due one-shot untouched', async () => {
  const f = await cronFixture('closed');
  try {
    await f.fire('* * * * *'); await f.finish();
    assert.equal(f.calls(), 0);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM reminders').get()!.n, 1);
    assert.deepEqual(f.effects, []);
  } finally { f.dispose(); }
});
test('an admitted reminder scan finishes under its original scope after closure', async () => {
  const f = await cronFixture('open');
  try {
    f.holdScan(); await f.fire('* * * * *'); await f.scanStarted.promise;
    assert.equal(f.count(), 1);
    await f.close(); f.resumeScan.resolve(); await f.finish();
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM reminders').get()!.n, 0);
    assert.equal(f.effects.filter(e => e === 'native-dispatch').length, 1);
    assert.equal(f.count(), 0);
    assert.equal((await f.internal('/__internal/scheduled', { fireId: 'other', projectId: 'P', jobId: 'J' })).status, 503);
  } finally { f.resumeScan.resolve(); await f.finish(); f.dispose(); }
});
for (const route of ['reflect', 'review']) {
  test(`closed ${route} sweep leaves actual watermark state unchanged`, async () => {
    const f = await ingressFixture('closed');
    try {
      f.sql.exec(`INSERT INTO messages(project_id,conversation_id,sender_id,role,text,created_at,review_candidate)
        VALUES('P','conv','user','user','Can you fix it?',1,1);
        INSERT INTO reflection_state(project_id,last_message_id) VALUES('P',0);
        INSERT INTO review_state(project_id,last_reviewed_message_id) VALUES('P',0)`);
      assert.equal((await f.internal(`/__internal/${route}-sweep`, {})).status, 503);
      assert.equal(f.sql.prepare('SELECT last_message_id FROM reflection_state').get()!.last_message_id, 0);
      assert.equal(f.sql.prepare('SELECT last_reviewed_message_id FROM review_state').get()!.last_reviewed_message_id, 0);
      assert.deepEqual(f.effects, []);
    } finally { await f.finishJobs(); f.dispose(); }
  });
}
test('closed coding reconcile registers accepted recovery and still dispatches durable queued work', async () => {
  const f = await ingressFixture('closed');
  try {
    const { createAgentRun } = await import('../agent-runs/repository');
    await createAgentRun(f.env.DB, { projectId: 'P', sourceType: 'internal', idempotencyKey: 'accepted', targetRepo: 'github.com/example/repo',
      dispatchPayload: JSON.stringify({ targetRepo: 'github.com/example/repo', baseBranch: 'main', kit: 'coding-default', runtime: 'pi', sandboxProvider: 'e2b' }) });
    const response = f.internal('/__internal/agent-runs/reconcile', {});
    await Promise.race([f.runnerStarted.promise, response.then(async res => {
      throw new Error(`reconcile returned before runner dispatch: ${res.status} ${await res.text()}`);
    })]);
    assert.equal(f.count(), 1);
    assert.equal(f.sql.prepare('SELECT kind FROM cutover_producers').get()!.kind, 'drain');
    assert.equal((await f.internal('/__internal/replies/reconcile', {})).status, 200);
    f.runnerDispatch.resolve(Response.json({ id: 'trigger-1' }));
    assert.equal((await response).status, 200); await f.finishJobs();
    assert.equal(f.sql.prepare('SELECT status FROM agent_runs').get()!.status, 'running');
    assert.equal(f.count(), 0);
  } finally { f.runnerDispatch.resolve(Response.json({ id: 'trigger-1' })); await f.finishJobs(); f.dispose(); }
});
test('unknown cron and missing heartbeat do not consume reminders', async () => {
  const f = await cronFixture('open');
  try {
    await f.fire('unknown'); await f.fire('* * * * *', { DB: f.env.DB, CUTOVER_CONTROL: 'd1' }); await f.finish();
    assert.equal(f.calls(), 0); assert.equal(f.count(), 0);
  } finally { f.dispose(); }
});
test('configured scan fails closed with missing control schema or missing DB', async () => {
  const f = await cronFixture('open');
  try {
    f.sql.exec('DROP TABLE cutover_control');
    await f.fire('* * * * *'); await f.finish();
    await f.fire('* * * * *', { HEARTBEAT_TOKEN: 'test', CUTOVER_CONTROL: 'd1' }); await f.finish();
    assert.equal(f.calls(), 0);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM reminders').get()!.n, 1);
  } finally { f.dispose(); }
});
test('full reconciliation cron shares one invocation budget and drains owned work while closed', async () => {
  const f = await cronFixture('open');
  try {
    // Refuse the native boundary, then retain the exact ready request for the scheduled backstop.
    f.failDispatch(); await f.signedSlack(slackMessage()); await f.finishJobs();
    const first = f.sql.prepare('SELECT id,state FROM slack_ingress').get()!;
    assert.ok(['ready','uncertain','preparing'].includes(String(first.state)));
    await f.close();
    f.sql.exec('UPDATE slack_ingress SET next_attempt_at=0');
    const env = ingressBudget.withIngressBudget(f.env);
    await f.fire('*/2 * * * *', env); await f.finish();
    const budget = ingressBudget.ingressBudget(env.DB)!;
    assert.ok(budget.used > 10); assert.ok(budget.used <= 50, `aggregate statements: ${budget.used}`);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM slack_ingress').get()!.n,1);
    assert.equal(f.sql.prepare('SELECT state FROM cutover_control').get()!.state,'closed');
    assert.equal(f.count(), 1); // Unknown native response remains owned; no replacement event.
  } finally { await f.finish(); f.dispose(); }
});
test('populated reconciliation backlog and pending ingress fit the hard fifty-statement binding', async () => {
  const f = await cronFixture('open');
  try {
    f.failDispatch(); await f.signedSlack(slackMessage()); await f.finishJobs(); await f.close();
    f.sql.exec('UPDATE slack_ingress SET next_attempt_at=0');
    const retained = f.sql.prepare('SELECT id,manifest_id,event_json FROM slack_ingress').get()!;
    for (let i = 0; i < 25; i++) f.sql.prepare(`INSERT INTO agent_runs(id,project_id,source_type,idempotency_key,target_repo,
      status,dispatch_attempts,created_at,updated_at) VALUES(?,'P','internal',?,'example/repo','dispatching',100,0,0)`)
      .run(`run-${i}`, `run-${i}`);
    const binding = hardBinding(f.env.DB);
    const env = ingressBudget.withIngressBudget({ ...f.env, DB: binding.db });
    await f.fire('*/2 * * * *', env); await f.finish();
    assert.deepEqual(f.sql.prepare('SELECT id,manifest_id,event_json FROM slack_ingress').get(), retained);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM cutover_producers WHERE id=?').get(retained.id)!.n, 1);
    assert.equal(f.sql.prepare('SELECT state FROM cutover_control').get()!.state, 'closed');
    assert.ok(binding.issued() <= 50);
    assert.equal(binding.refused(), 0, `reconciliation exceeded fifty; counted=${ingressBudget.ingressBudget(env.DB)!.used}`);
    assert.ok(ingressBudget.ingressBudget(env.DB)!.used <= 50);
  } finally { await f.finish(); f.dispose(); }
});
test('four populated ticks rotate first access and recover the exact frozen ingress under hard limits', async () => {
  const f = await cronFixture('open');
  try {
    f.sql.exec("INSERT INTO personas(project_id,name,updated_by,created_at,updated_at) VALUES('P','Owl','test',0,0)");
    f.failDispatch(); await f.signedSlack(slackMessage()); await f.finishJobs(); await f.close();
    assert.equal(f.nativeRequests.length, 1, 'setup loses an actual first handoff response');
    f.sql.exec('UPDATE slack_ingress SET next_attempt_at=0'); f.resumeDispatch();
    const before = f.sql.prepare('SELECT id,manifest_id,target_json FROM slack_ingress').get()!;
    const chunks = f.sql.prepare('SELECT digest FROM slack_ingress_chunks ORDER BY ordinal').all();
    for (let i = 0; i < 100; i++) f.sql.prepare(`INSERT INTO agent_runs(id,project_id,source_type,idempotency_key,target_repo,
      status,dispatch_attempts,created_at,updated_at) VALUES(?,'P','internal',?,'example/repo','dispatching',100,0,0)`)
      .run(`old-${i}`, `old-${i}`);
    const firsts: string[] = [];
    for (let tick = 0; tick < 4; tick++) {
      const binding = hardBinding(f.env.DB), env = ingressBudget.withIngressBudget({ ...f.env, DB: binding.db });
      const start = f.routes.length;
      await f.fire('*/2 * * * *', env, tick * 120_000); await f.finish();
      firsts.push(f.routes[start]);
      assert.equal(binding.refused(), 0); assert.ok(binding.issued() <= 50);
      assert.equal(ingressBudget.ingressBudget(env.DB)!.used, binding.issued());
      assert.equal(ingressBudget.ingressBudget(env.DB)!.reserved, 0);
      assert.equal(f.sql.prepare('SELECT state FROM cutover_control').get()!.state, 'closed');
    }
    assert.deepEqual(firsts, ['/__internal/agent-runs/reconcile','/__internal/replies/reconcile',
      '/__internal/review-sweep','/__internal/slack-ingress/reconcile']);
    assert.deepEqual(f.sql.prepare('SELECT id,manifest_id,target_json FROM slack_ingress').get(), before);
    assert.deepEqual(f.sql.prepare('SELECT digest FROM slack_ingress_chunks ORDER BY ordinal').all(), chunks);
    assert.equal(f.sql.prepare('SELECT state FROM slack_ingress').get()!.state, 'accepted');
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM cutover_producers WHERE id=?').get(before.id)!.n, 0);
    assert.ok(f.nativeRequests.length >= 2);
    for (const request of f.nativeRequests) assert.deepEqual(request, f.nativeRequests[0]);
    assert.equal(f.effects.filter(x => x === 'fetch:/api/chat.postMessage').length, 1);
  } finally { await f.finish(); f.dispose(); }
});
test('populated timeouts, notifications and reply delivery/finalization fit one real scheduled scope', async () => {
  const f = await cronFixture('closed');
  try {
    const { createAgentRunChannelNotifications } = await import('../agent-runs/events');
    const { stageReply } = await import('../slack/reply-outbox');
    for (let i = 0; i < 20; i++) {
      f.sql.prepare(`INSERT INTO agent_runs(id,project_id,source_type,idempotency_key,target_repo,status,
        created_at,updated_at) VALUES(?,'P','internal',?,'example/repo','running',0,0)`).run(`run-${i}`,`run-${i}`);
      await createAgentRunChannelNotifications(f.env.DB, { projectId: 'P', runId: `run-${i}`, notificationType: 'failed' });
      const target = { projectId: 'P', agentSlug: 'default', conversationId: `slack:T:C:${i}.0`, provider: 'slack' as const,
        externalAccountId: 'T', externalSpaceId: 'C', externalConversationId: `${i}.0`, transportTokenRef: 'TEST_SLACK_TOKEN' };
      await stageReply(f.env.DB, { instanceId: `reply-${i}`, responseId: 'R', target, text: 'answer' });
      if (i >= 10) {
        f.sql.prepare("UPDATE slack_reply_outbox SET status='sent',posted_ts='2.0' WHERE instance_id=?").run(`reply-${i}`);
        f.sql.prepare(`INSERT INTO slack_reply_trackers(instance_id,event_id,target_json,publish,status,response_id,created_at,updated_at)
          VALUES(?,'E',?,1,'staged','R',0,0)`).run(`reply-${i}`, JSON.stringify(target));
      }
    }
    for (const tick of [0,1]) {
      const binding = hardBinding(f.env.DB), env = ingressBudget.withIngressBudget({ ...f.env, DB: binding.db });
      await f.fire('*/2 * * * *', env, tick * 120_000); await f.finish();
      assert.equal(binding.refused(),0); assert.ok(binding.issued() <= 50);
      assert.equal(ingressBudget.ingressBudget(env.DB)!.reserved,0);
    }
    assert.ok(Number(f.sql.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE status='failed'").get()!.n) > 0);
    assert.ok(Number(f.sql.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE status='running'").get()!.n) > 0);
    assert.ok(Number(f.sql.prepare("SELECT COUNT(*) AS n FROM agent_run_notifications WHERE channel='slack' AND status='sent'").get()!.n) > 0);
    assert.ok(Number(f.sql.prepare("SELECT COUNT(*) AS n FROM slack_reply_trackers WHERE status='delivered'").get()!.n) > 0);
  } finally { await f.finish(); f.dispose(); }
});
test('open review reserves context before watermark consumption and skips with insufficient room', async () => {
  const f = await cronFixture('open');
  try {
    f.useRealInternalPreparation();
    f.sql.exec("INSERT INTO messages(project_id,conversation_id,sender_id,role,text,created_at,review_candidate) VALUES('P','conv','U','user','Question?',0,1)");
    const small = ingressBudget.withIngressBudget(f.env, 22);
    assert.equal((await f.app.fetch(new Request('https://fixture.example/__internal/review-sweep', {
      method: 'POST', headers: { 'x-morehands-token': f.env.HEARTBEAT_TOKEN }, body: '{}',
    }), small, { waitUntil() {} })).status, 200);
    assert.equal(ingressBudget.ingressBudget(small.DB)!.used, 0);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM review_state').get()!.n, 0);
    assert.equal(f.count(), 0);
    const binding = hardBinding(f.env.DB), env = ingressBudget.withIngressBudget({ ...f.env, DB: binding.db });
    await f.fire('*/2 * * * *', env, 2 * 120_000); await f.finish();
    assert.equal(f.routes[0], '/__internal/review-sweep'); assert.equal(binding.refused(),0);
    assert.ok(Number(f.sql.prepare('SELECT last_reviewed_message_id FROM review_state').get()!.last_reviewed_message_id) > 0);
    assert.ok(f.dispatchRequests.some(request => request.id.includes('/review:')));
    assert.equal(ingressBudget.ingressBudget(env.DB)!.reserved,0); assert.equal(f.count(),0);
  } finally { await f.finish(); f.dispose(); }
});
await run();
