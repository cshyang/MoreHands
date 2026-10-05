import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { ingressFixture, slackMessage } from '../cutover/ingress-test-fixture';
import { ingressDbFixture, verifiedFixture } from './test-utils/ingress-db';
import { acceptSlackIngress, claimSlackIngress } from './ingress-store';
import { guardedIngressEffectsDb } from './accepted-event';
import { logMessage } from '../knowledge/reflection';
import { recordSlackConversationFiles } from './file-authorizations';
const { test, run } = createTestRunner();

test('guarded helper writes require the live SQL lease at execution time', async () => {
  const f = ingressDbFixture();
  try {
    await acceptSlackIngress(f.db, verifiedFixture(), { id: 'I', now: 100 });
    const lease = (await claimSlackIngress(f.db, 'I', { owner: 'A', phase: 'prepare', now: 100, leaseMs: 100 }))!;
    let now = 100;
    const db = guardedIngressEffectsDb(f.db, lease, () => now);
    await logMessage(db, { projectId: 'P', conversationId: 'C', senderId: 'U', role: 'user', text: 'first', deliveryId: 'd1', now });
    assert.equal(f.count('messages'), 1);
    const delayed = db.prepare('INSERT INTO messages(project_id,conversation_id,sender_id,role,text,created_at) VALUES(?,?,?,?,?,?)').bind('P','C','U','user','late',100);
    now = 201;
    await delayed.run();
    await recordSlackConversationFiles(db, { projectId: 'P', conversationId: 'C', files: [{ id: 'F' }] });
    assert.equal(f.count('messages'), 1); assert.equal(f.count('slack_conversation_files'), 0);
    assert.throws(() => db.prepare("UPDATE messages SET text='unsafe'").bind().run(), /Unsupported guarded product write/);
  } finally { f.dispose(); }
});

test('joined engagement preserves existing receipt activity and uses best-effort eyes', async () => {
  const f = await ingressFixture('open');
  try {
    f.sql.exec(`INSERT INTO slack_turn_activity(project_id,session_id,conversation_id,slack_channel_id,slack_thread_ts,ack_message_ts,transport_token_ref,status,activities_json,created_at,updated_at)
      VALUES('P','conv:slack:T:C:1.0','slack:T:C:1.0','C','1.0','old.0','TEST_SLACK_TOKEN','active','[{"label":"Work","count":1,"status":"running"}]',1,2)`);
    const before = f.sql.prepare('SELECT * FROM slack_turn_activity').get();
    assert.equal((await f.signedSlack(slackMessage())).status, 200); await f.finishJobs();
    await f.internal('/__internal/slack-ingress/reconcile', {});
    assert.deepEqual(f.sql.prepare('SELECT * FROM slack_turn_activity').get(), before);
    assert.equal(f.effects.filter(x => x === 'fetch:/api/chat.postMessage').length, 0);
    assert.equal(f.effects.filter(x => x === 'fetch:/api/reactions.add').length, 1);
    assert.equal(f.count(), 0);
  } finally { await f.finishJobs(); f.dispose(); }
});

test('unhatched binding receives its existing soul assignment before route freezes', async () => {
  const f = await ingressFixture('open');
  try {
    f.sql.prepare("INSERT INTO skills(project_id,name,description,body_md,state,created_by,updated_by,created_at,updated_at) VALUES('__global__','soul-owl','seed',?,'active','system','system',0,0)").run('---\nname: soul-owl\n---\nPERSONA: Owl\nBe helpful.');
    await f.signedSlack(slackMessage()); await f.finishJobs();
    await f.internal('/__internal/slack-ingress/reconcile', {});
    const route = JSON.parse(String(f.sql.prepare('SELECT target_json FROM slack_ingress').get()!.target_json));
    assert.equal(route.persona?.name, 'Owl');
    assert.equal(f.sql.prepare('SELECT name FROM personas WHERE project_id=?').get('P')!.name, 'Owl');
    assert.equal(f.dispatchRequests.length, 1);
  } finally { await f.finishJobs(); f.dispose(); }
});

test('repeated preparation preserves advanced activity for the same acknowledgement', async () => {
  const f = await ingressFixture('open');
  try {
    f.failDispatch(); await f.signedSlack(slackMessage()); await f.finishJobs();
    // Only rewind unpublished preparation in this fixture; SQL identity and route stay frozen.
    const row = f.sql.prepare('SELECT * FROM slack_ingress').get()!;
    assert.ok(row.target_json);
    f.sql.exec("UPDATE slack_turn_activity SET status='completed',activities_json='[{\"label\":\"Done\"}]',updated_at=99,completed_at=99");
    const before = f.sql.prepare('SELECT * FROM slack_turn_activity').get();
    const { prepareAcceptedSlackEvent } = await import('./accepted-event');
    // Prepare helpers can be exercised under the original live prepare lease using a separate event fixture below.
    const db = ingressDbFixture();
    try {
      db.sql.exec(`INSERT INTO bindings(project_id,provider,external_account_id,external_space_id,transport_bot_id,transport_token_ref,status,created_at,updated_at) VALUES('P','slack','T','C','BOT','TEST_SLACK_TOKEN','active',0,0)`);
      const event = verifiedFixture('E'); event.eventJson = JSON.stringify(slackMessage());
      await acceptSlackIngress(db.db, event, { id: 'I' });
      const now = Date.now(), lease = (await claimSlackIngress(db.db, 'I', { owner:'A',phase:'prepare',now,leaseMs:60_000 }))!;
      const { readSlackIngress } = await import('./ingress-store');
      await prepareAcceptedSlackEvent({ ...f.env, DB: db.db }, (await readSlackIngress(db.db,'I'))!,lease);
      db.sql.exec("UPDATE slack_turn_activity SET status='completed',activities_json='[{\"label\":\"Done\"}]',updated_at=99,completed_at=99");
      const current = db.sql.prepare('SELECT * FROM slack_turn_activity').get();
      await prepareAcceptedSlackEvent({ ...f.env, DB: db.db }, (await readSlackIngress(db.db,'I'))!,lease);
      assert.deepEqual(db.sql.prepare('SELECT * FROM slack_turn_activity').get(), current);
      assert.equal(db.count('messages'), 1);
    } finally { db.dispose(); }
    assert.deepEqual(f.sql.prepare('SELECT * FROM slack_turn_activity').get(), before);
  } finally { await f.finishJobs(); f.dispose(); }
});
for (const mutation of ['binding','epoch']) test(`route freeze aborts a concurrent ${mutation} change before Slack or native effects`, async () => {
  const f = await ingressFixture('open');
  const prepare = f.env.DB.prepare.bind(f.env.DB); let armed = true;
  f.env.DB.prepare = query => {
    const prepared = prepare(query);
    return { bind:(...values) => {
      const statement = prepared.bind(...values), first = statement.first.bind(statement);
      statement.first = async <T>() => {
        if (armed && query.includes('SET target_json=') && query.includes('instance_id=')) {
          armed=false;
          if (mutation==='binding') f.sql.exec("UPDATE bindings SET transport_token_ref='OTHER' WHERE project_id='P'");
          else f.sql.exec('UPDATE conversation_targets SET agent_epoch=agent_epoch+1');
        }
        return first<T>();
      };
      return statement;
    } };
  };
  try {
    assert.equal((await f.signedSlack(slackMessage())).status,200); await f.finishJobs();
    assert.equal(armed,false); assert.equal(f.count(),1);
    assert.equal(f.sql.prepare('SELECT target_json FROM slack_ingress').get()!.target_json,null);
    assert.equal(f.effects.filter(e=>e==='fetch:/api/chat.postMessage').length,0);
    assert.equal(f.effects.filter(e=>e==='native-dispatch').length,0);
  } finally { await f.finishJobs(); f.dispose(); }
});
await run();
