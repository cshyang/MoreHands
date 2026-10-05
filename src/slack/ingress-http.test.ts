import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { ingressFixture, slackMessage } from '../cutover/ingress-test-fixture';
import { deferred } from '../cutover/test-fixtures';
import { withIngressBudget, ingressBudget } from './ingress-budget';
const { test, run } = createTestRunner();
test('signed HTTP response waits for atomic inbox commit before any preparation', async () => {
  const f = await ingressFixture('open'), entered = deferred<void>(), release = deferred<void>();
  const batch = f.env.DB.batch.bind(f.env.DB);
  f.env.DB.batch = async statements => { entered.resolve(); await release.promise; return batch(statements); };
  let resolved = false;
  const response = f.signedSlack(slackMessage()).then(r => { resolved = true; return r; });
  try {
    await entered.promise;
    assert.equal(resolved, false); assert.deepEqual(f.effects, []);
    assert.equal(f.count(), 0);
    release.resolve();
    assert.equal((await response).status, 200);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM slack_ingress').get()!.n, 1);
    await f.finishJobs();
  } finally { release.resolve(); await f.finishJobs(); f.dispose(); }
});
test('lost acceptance commit response is repaired by a matching retry after closure', async () => {
  const f = await ingressFixture('open');
  const batch = f.env.DB.batch.bind(f.env.DB); let lose = true;
  f.env.DB.batch = async statements => { const result = await batch(statements); if (lose) { lose = false; throw new Error('lost committed response'); } return result; };
  try {
    assert.equal((await f.signedSlack(slackMessage())).status, 503);
    assert.equal(f.count(), 1); assert.equal(f.dispatchRequests.length, 0);
    await f.close();
    assert.equal((await f.signedSlack(slackMessage())).status, 200);
    await f.finishJobs();
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM slack_ingress').get()!.n, 1);
  } finally { await f.finishJobs(); f.dispose(); }
});
test('digest conflict is rejected without changing the original event or producer', async () => {
  const f = await ingressFixture('open');
  try {
    const body = slackMessage(); body.event.text = 'ambient observation';
    assert.equal((await f.signedSlack(body)).status, 200); await f.finishJobs();
    const before = f.sql.prepare('SELECT * FROM slack_ingress').get();
    body.event.text = 'changed bytes';
    assert.equal((await f.signedSlack(body)).status, 409);
    assert.deepEqual(f.sql.prepare('SELECT * FROM slack_ingress').get(), before);
  } finally { await f.finishJobs(); f.dispose(); }
});
test('quiet tombstone retains duplicate identity under a closed fence', async () => {
  const f = await ingressFixture('open');
  try {
    const body = slackMessage(); body.event.text = 'ambient observation';
    await f.signedSlack(body); await f.finishJobs(); await f.close();
    const row = f.sql.prepare('SELECT event_json,content_retention FROM slack_ingress').get()!;
    assert.equal(row.event_json, '{}'); assert.equal(row.content_retention, 'tombstoned');
    assert.equal((await f.signedSlack(body)).status, 200); await f.finishJobs();
    assert.equal(f.count(), 0); assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n, 1);
  } finally { await f.finishJobs(); f.dispose(); }
});
test('waitUntil registration failure after commit still acknowledges durable ownership', async () => {
  const f = await ingressFixture('open');
  try {
    f.throwOnScheduling(); assert.equal((await f.signedSlack(slackMessage())).status, 200);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM slack_ingress').get()!.n, 1);
  } finally { await f.finishJobs(); f.dispose(); }
});
test('missing event identity and malformed supported work cannot enter the inbox', async () => {
  const f = await ingressFixture('open');
  try {
    for (const mutation of ['id','ts','user','text']) {
      const body: Record<string, any> = slackMessage();
      if (mutation === 'id') delete body.event_id;
      else if (mutation === 'ts') delete body.event.ts;
      else body.event[mutation] = { nested: 'untrusted' };
      assert.equal((await f.signedSlack(body)).status, 400);
    }
    assert.equal(f.count(), 0); assert.deepEqual(f.effects, []);
  } finally { f.dispose(); }
});
test('raw event size is bounded before acceptance and supported private metadata is excluded', async () => {
  const f = await ingressFixture('open');
  try {
    const large = slackMessage(); large.event.text = 'x'.repeat(1_000_000);
    assert.equal((await f.signedSlack(large)).status, 413); assert.equal(f.count(), 0);
    const body: Record<string, any> = slackMessage(); body.event.text = 'ambient';
    body.event.files = [{ id: 'F', name: 'file.txt', mimetype: 'text/plain', size: 1, url_private: 'https://private.invalid/do-not-persist' }];
    const post = f.holdAcknowledgement();
    assert.equal((await f.signedSlack(body)).status, 200);
    const raw = String(f.sql.prepare('SELECT event_json FROM slack_ingress').get()!.event_json);
    assert.ok(!raw.includes('private.invalid')); post.resolve(Response.json({ ok: true, ts: '2.0' }));
  } finally { await f.finishJobs(); f.dispose(); }
});
test('guarded internal recovery rejects caller-provided native input and missing authorization', async () => {
  const f = await ingressFixture();
  try {
    assert.equal((await f.internal('/__internal/slack-ingress/reconcile', { request: { message: 'unsafe' } })).status, 400);
    assert.equal((await f.internal('/__internal/slack-ingress/reconcile', {}, { 'x-morehands-token': 'wrong' })).status, 404);
    assert.equal(f.count(), 0);
  } finally { await f.finishJobs(); f.dispose(); }
});
test('quiet attachment metadata is removed from the extra ingress copy at completion', async () => {
  const f = await ingressFixture('open');
  try {
    const body = slackMessage(); body.event.text = 'ambient';
    Object.assign(body.event,{files:[{id:'F',name:'private-name.txt',mimetype:'text/plain',size:1}]});
    await f.signedSlack(body); await f.finishJobs();
    const row = f.sql.prepare('SELECT event_json,file_effects_json,file_effect_cursor FROM slack_ingress').get()!;
    assert.equal(row.event_json,'{}'); assert.equal(row.file_effects_json,null); assert.equal(row.file_effect_cursor,0);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM slack_conversation_files').get()!.n,1);
  } finally { await f.finishJobs(); f.dispose(); }
});
test('ordinary text acceptance and immediate handoff share at most fifty statements', async () => {
  const f = await ingressFixture('open');
  try {
    f.sql.exec("INSERT INTO personas(project_id,name,updated_by,created_at,updated_at) VALUES('P','Owl','test',0,0)");
    f.env.DB = withIngressBudget(f.env).DB;
    await f.signedSlack(slackMessage()); await f.finishJobs();
    const budget = ingressBudget(f.env.DB)!;
    assert.ok(budget.used <= 50, `statements:${budget.used}`);
    assert.equal(f.sql.prepare('SELECT state FROM slack_ingress').get()!.state,'accepted');
    assert.equal(f.effects.filter(e=>e==='native-dispatch').length,1);
  } finally { await f.finishJobs(); f.dispose(); }
});
for (const [name, queryPart] of [
  ['binding', 'FROM bindings WHERE project_id='],
  ['catalog', 'SELECT name, description, project_id FROM skills'],
  ['personality', 'SELECT body_md, project_id FROM skills'],
  ['memory', 'FROM memories'],
  ['connections', 'FROM connections'],
]) test(`one temporary ${name} read after ACK defers and resumes the same accepted event`, async () => {
  const f = await ingressFixture('open');
  f.sql.exec("INSERT INTO personas(project_id,name,updated_by,created_at,updated_at) VALUES('P','Owl','test',0,0)");
  f.sql.exec("INSERT INTO skills(project_id,name,description,body_md,updated_at) VALUES('P','personality','voice','Be direct.',0)");
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  let faults = 0;
  f.env.DB.prepare = query => ({ bind: (...values) => {
    const actual = prepare(query).bind(...values);
    if (query.includes(queryPart) && faults === 0) return { ...actual, all: async () => {
      faults++; throw new Error('temporary required context read unavailable');
    } };
    return actual;
  } });
  try {
    assert.equal((await f.signedSlack(slackMessage())).status, 200); await f.finishJobs();
    const before = f.sql.prepare('SELECT * FROM slack_ingress').get()!;
    assert.equal(faults, 1); assert.equal(before.state, 'preparing');
    assert.equal(before.failure_category, 'preparation-deferred');
    assert.equal(before.ack_state, 'posted'); assert.equal(before.effects_complete, 1);
    assert.equal(f.count(), 1); assert.equal(f.effects.filter(e => e === 'native-dispatch').length, 0);
    await f.close();
    assert.equal((await f.signedSlack(slackMessage())).status, 200); await f.finishJobs();
    assert.equal(f.effects.filter(e => e === 'native-dispatch').length, 0, 'duplicate respects recorded backoff');
    f.sql.exec('UPDATE slack_ingress SET next_attempt_at=0');
    assert.equal((await f.internal('/__internal/slack-ingress/reconcile', {})).status, 200); await f.finishJobs();
    const after = f.sql.prepare('SELECT * FROM slack_ingress').get()!;
    assert.equal(after.state, 'accepted'); assert.equal(f.count(), 0);
    assert.equal(f.effects.filter(e => e === 'native-dispatch').length, 1);
    assert.equal(f.effects.filter(e => e === 'fetch:/api/chat.postMessage').length, 1);
    for (const key of ['id','team_id','event_id','digest','target_json','ack_json','ack_message_ts']) assert.equal(after[key], before[key]);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n, 1);
  } finally { await f.finishJobs(); f.dispose(); }
});
await run();
