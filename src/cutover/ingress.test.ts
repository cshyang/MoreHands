import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { ingressFixture, slackMessage, linearIssue } from './ingress-test-fixture';

const { test, run } = createTestRunner();
// Removing a gate permits real claims/product writes; response-only release loses deferred ownership.
for (const route of ['slack', 'scheduled', 'work-item', 'linear-issue', 'linear-comment']) {
  test(`closed control rejects verified ${route} before consuming effects`, async () => {
    const f = await ingressFixture();
    try {
      const response = route === 'slack' ? await f.signedSlack(slackMessage())
        : route === 'scheduled' ? await f.internal('/__internal/scheduled', { fireId: 'F', projectId: 'P', jobId: 'J' })
        : route === 'work-item' ? await f.internal('/__internal/work-items', { projectId: 'P', title: 'work' })
        : await f.signedLinear(linearIssue(), route === 'linear-comment' ? 'Comment' : 'Issue');
      assert.equal(response.status, 503);
      assert.deepEqual(f.effects, []);
      assert.equal(f.count(), 0);
      await f.finishJobs();
    } finally { f.runnerDispatch.resolve(Response.json({ id: 'trigger-1' })); await f.finishJobs(); f.dispose(); }
  });
}
test('closed control preserves signature checks, URL verification, and ignored events', async () => {
  const f = await ingressFixture();
  try {
    assert.equal((await f.unsignedSlack()).status, 401);
    assert.equal((await f.signedSlack({ type: 'url_verification', challenge: 'test' })).status, 200);
    assert.equal((await f.signedSlack({ type: 'event_callback', event: { type: 'reaction_added' } })).status, 200);
    assert.equal((await f.signedLinear(linearIssue(), 'Issue', false)).status, 404);
    assert.equal((await f.internal('/__internal/scheduled', {}, { 'x-morehands-token': 'wrong' })).status, 404);
    assert.deepEqual(f.effects, []);
    assert.equal(f.count(), 0);
  } finally { f.dispose(); }
});
test('closed control leaves commands and authenticated runner callbacks callable', async () => {
  const f = await ingressFixture();
  try {
    assert.equal((await f.commands()).status, 200);
    assert.equal((await f.internal('/__internal/source-change-runs', {}, { 'x-morehands-runner-token': 'test-source' })).status, 400);
    assert.equal((await f.internal('/__internal/agent-runs', {}, { 'x-morehands-agent-runner-token': 'test-runner' })).status, 400);
    assert.equal(f.count(), 0);
  } finally { await f.finishJobs(); f.dispose(); }
});
test('enabled database failure rejects before Slack effects', async () => {
  const f = await ingressFixture('open');
  try {
    f.failDatabase();
    assert.equal((await f.signedSlack(slackMessage())).status, 503);
    assert.deepEqual(f.effects, []);
  } finally { f.dispose(); }
});
test('open work-item intake persists actual work and releases after successful dispatch', async () => {
  const f = await ingressFixture('open');
  try {
    assert.equal((await f.internal('/__internal/work-items', { projectId: 'P', title: 'work' })).status, 200);
    await f.finishJobs();
    assert.equal(f.sql.prepare('SELECT title FROM work_items').get()!.title, 'work');
    assert.equal(f.sql.prepare('SELECT dispatch_status FROM work_runs').get()!.dispatch_status, 'dispatched');
    assert.equal(f.count(), 0);
  } finally { f.dispose(); }
});
test('successful HTTP response cannot release a failed work-item producer', async () => {
  const f = await ingressFixture('open');
  try {
    f.failDispatch();
    assert.equal((await f.internal('/__internal/work-items', { projectId: 'P', title: 'work' })).status, 200);
    await f.finishJobs();
    assert.equal(f.sql.prepare('SELECT dispatch_status FROM work_runs').get()!.dispatch_status, 'failed');
    assert.equal(f.count(), 1);
  } finally { f.dispose(); }
});
for (const fails of [false, true]) {
  test(`Linear deferred ${fails ? 'failed' : 'successful'} dispatch owns its producer after HTTP response and closure`, async () => {
    const f = await ingressFixture('open');
    try {
      assert.equal((await f.signedLinear(linearIssue(), 'Issue')).status, 200);
      await f.runnerStarted.promise;
      await f.close();
      assert.equal(f.sql.prepare('SELECT status FROM agent_runs').get()!.status, 'dispatching');
      assert.equal(f.count(), 1);
      f.runnerDispatch.resolve(fails ? new Response('failed', { status: 503 }) : Response.json({ id: 'trigger-1' }));
      await f.finishJobs();
      assert.equal(f.sql.prepare('SELECT status FROM agent_runs').get()!.status, fails ? 'queued' : 'running');
      assert.equal(f.count(), fails ? 1 : 0);
    } finally { f.dispose(); }
  });
}
test('open Slack intake with an authorized image dispatches a vision user turn', async () => {
  const f = await ingressFixture('open');
  try {
    // Pre-authorize the file for this conversation so the vision path may fetch bytes.
    f.sql.exec(`INSERT INTO slack_conversation_files(project_id,conversation_id,file_id,name,mimetype,size,created_at,updated_at)
      VALUES ('P','slack:T:C:1.0','F1','pic.png','image/png',2,1,1)`);
    const body = slackMessage();
    (body.event as Record<string, unknown>).files = [{ id: 'F1', name: 'pic.png', mimetype: 'image/png', size: 2 }];
    assert.equal((await f.signedSlack(body)).status, 200);
    await f.finishJobs();
    await f.internal('/__internal/slack-ingress/reconcile', {});
    assert.deepEqual(f.dispatchRequests[0].imageFiles, [{ id: 'F1', name: 'pic.png', mimetype: 'image/png', size: 2 }]);
    assert.ok(f.effects.some(effect => effect.includes('files.info')));
    assert.equal(f.count(), 0);
  } finally { f.dispose(); }
});
test('open Slack intake with a non-image attachment keeps the plain signal dispatch', async () => {
  const f = await ingressFixture('open');
  try {
    const body = slackMessage();
    (body.event as Record<string, unknown>).files = [{ id: 'F9', name: 'notes.txt', mimetype: 'text/plain', size: 2 }];
    assert.equal((await f.signedSlack(body)).status, 200);
    await f.finishJobs();
    await f.internal('/__internal/slack-ingress/reconcile', {});
    assert.equal(f.dispatchRequests[0].imageFiles, undefined);
    assert.equal((f.dispatchRequests[0].input.attachedFiles as Array<{ id: string }>)[0].id, 'F9');
    assert.equal(f.count(), 0);
  } finally { f.dispose(); }
});
test('open Slack intake persists its tracker and transcript through bounded recovery', async () => {
  const f = await ingressFixture('open');
  try {
    assert.equal((await f.signedSlack(slackMessage())).status, 200);
    await f.finishJobs();
    await f.internal('/__internal/slack-ingress/reconcile', {});
    assert.equal(f.sql.prepare('SELECT submission_id FROM slack_reply_trackers').get()!.submission_id, 'submission-1');
    assert.equal(f.sql.prepare("SELECT role FROM messages WHERE role='user'").get()!.role, 'user');
    assert.equal(f.count(), 0);
  } finally { f.dispose(); }
});
test('ambiguous Slack dispatch retains its pending tracker and producer', async () => {
  const f = await ingressFixture('open');
  try {
    f.failDispatch();
    assert.equal((await f.signedSlack(slackMessage())).status, 200);
    await f.finishJobs();
    assert.equal(f.sql.prepare('SELECT status FROM slack_reply_trackers').get()!.status, 'pending');
    assert.equal(f.count(), 1);
  } finally { f.dispose(); }
});
test('open scheduled intake consumes its KV claim and dispatches', async () => {
  const f = await ingressFixture('open');
  try {
    const response = await f.internal('/__internal/scheduled', { fireId: 'F', projectId: 'P', jobId: 'J', kind: 'heartbeat', payload: { prompt: 'Check the project' } });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { dispatched?: boolean }).dispatched, true);
    await f.finishJobs();
    assert.ok(f.effects.includes('kv-claim'));
    assert.equal(f.count(), 0);
  } finally { f.dispose(); }
});
test('open Linear comment creates and owns an actual continuation dispatch', async () => {
  const f = await ingressFixture('open');
  try {
    const { createAgentRun, updateAgentRun } = await import('../agent-runs/repository');
    const { run: parent } = await createAgentRun(f.env.DB, { projectId: 'P', sourceType: 'linear', sourceId: 'issue-1',
      idempotencyKey: 'parent', targetRepo: 'github.com/example/repo', linearIssueId: 'issue-1', branch: 'work/fixture' });
    await updateAgentRun(f.env.DB, { id: parent.id, status: 'waiting_approval', branch: 'work/fixture', prUrl: 'https://github.com/example/repo/pull/1' });
    const response = await f.signedLinear({ action: 'create', type: 'Comment', webhookTimestamp: Date.now(),
      actor: { type: 'user', id: 'user-1' }, data: { id: 'comment-1', body: 'Update the fix', issueId: 'issue-1' } }, 'Comment');
    assert.equal(response.status, 200);
    await f.runnerStarted.promise;
    await f.close();
    assert.equal(f.count(), 1);
    f.runnerDispatch.resolve(Response.json({ id: 'trigger-2' }));
    await f.finishJobs();
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM agent_runs').get()!.n, 2);
    assert.equal(f.count(), 0);
  } finally { f.runnerDispatch.resolve(Response.json({ id: 'trigger-2' })); await f.finishJobs(); f.dispose(); }
});
for (const rejects of [false, true]) {
  test(`Slack route owns unresolved acknowledgement through late ${rejects ? 'failure' : 'success'}`, async () => {
    const f = await ingressFixture('open');
    const post = f.holdAcknowledgement();
    try {
      assert.equal((await f.signedSlack(slackMessage())).status, 200);
      await post.started;
      await f.close();
      assert.equal(f.count(), 1);
      if (rejects) post.reject(new Error('late Slack failure'));
      else post.resolve(Response.json({ ok: true, ts: '2.0' }));
      await f.finishJobs();
      if (!rejects) await f.internal('/__internal/slack-ingress/reconcile', {});
      assert.equal(f.count(), rejects ? 1 : 0);
    } finally { post.resolve(Response.json({ ok: true, ts: '2.0' })); await f.finishJobs(); f.dispose(); }
  });
}
const imageFile = { id: 'F', name: 'pic.png', mimetype: 'image/png', size: 68 };
for (const dm of [true, false]) test(`${dm ? 'file-only DM' : 'bare mention with image'} dispatches safe attachment metadata`, async () => {
  const f = await ingressFixture('open');
  try {
    const body = slackMessage();
    body.event.text = dm ? '' : '<@BOT>';
    Object.assign(body.event, { files: [imageFile], ...(dm ? { channel_type: 'im' } : {}) });
    assert.equal((await f.signedSlack(body)).status, 200);
    await f.finishJobs();
    assert.equal(f.dispatchRequests.length, 1);
    assert.equal(f.dispatchRequests[0].input.message, '');
    assert.equal(f.dispatchRequests[0].input.conversationId, 'slack:T:C:1.0');
    assert.deepEqual(f.dispatchRequests[0].input.attachedFiles, [imageFile]);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM slack_conversation_files').get()!.n, 1);
  } finally { await f.finishJobs(); f.dispose(); }
});
test('ambient image authorizes once without dispatch or Slack chrome', async () => {
  const f = await ingressFixture('open');
  try {
    const body = slackMessage(); body.event.text = '';
    Object.assign(body.event, { files: [imageFile] });
    await f.signedSlack(body); await f.finishJobs();
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM slack_conversation_files').get()!.n, 1);
    assert.equal(f.dispatchRequests.length, 0);
    assert.ok(!f.effects.some(effect => effect.startsWith('fetch:')));
    await f.signedSlack(body); await f.finishJobs();
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n, 1);
  } finally { f.dispose(); }
});
for (const threaded of [true, false]) test(`later ${threaded ? 'thread' : 'channel'} question discovers and authorizes scoped history handles`, async () => {
  const f = await ingressFixture('open');
  try {
    f.setHistory([{ user: 'U', text: '', ts: '0.5', files: [imageFile] }]);
    const body = slackMessage();
    if (threaded) Object.assign(body.event, { thread_ts: '0.5' });
    await f.signedSlack(body); await f.finishJobs();
    const request = f.dispatchRequests[0];
    assert.ok(String(request.input[threaded ? 'threadContext' : 'channelContext']).includes('[file F: pic.png (image/png)]'));
    assert.deepEqual(request.input.historyFiles, [imageFile]);
    const grants = f.sql.prepare('SELECT project_id,conversation_id,file_id FROM slack_conversation_files').all();
    assert.deepEqual(grants.map(row => ({ ...row })), [{ project_id: 'P', conversation_id: threaded ? 'slack:T:C:0.5' : 'slack:T:C:1.0', file_id: 'F' }]);
    assert.equal(f.effects.filter(effect => effect === `fetch:/api/conversations.${threaded ? 'replies' : 'history'}`).length, 1);
    const { isSlackConversationFileAllowed } = await import('../slack/file-authorizations');
    assert.equal(await isSlackConversationFileAllowed(f.env.DB, { projectId: 'OTHER', conversationId: String(request.input.conversationId), fileId: 'F' }), false);
    assert.equal(await isSlackConversationFileAllowed(f.env.DB, { projectId: 'P', conversationId: 'slack:T:OTHER:0.5', fileId: 'F' }), false);
  } finally { f.dispose(); }
});
test('closed fence rejects attachment ingress without history, grants, or dispatch', async () => {
  const f = await ingressFixture();
  try {
    const body = slackMessage(); Object.assign(body.event, { files: [imageFile], thread_ts: '0.5' });
    assert.equal((await f.signedSlack(body)).status, 503);
    await f.finishJobs();
    assert.deepEqual(f.effects, []);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM slack_conversation_files').get()!.n, 0);
    assert.equal(f.dispatchRequests.length, 0);
  } finally { f.dispose(); }
});
await run();
