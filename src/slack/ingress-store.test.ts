import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { ingressDbFixture, verifiedFixture } from './test-utils/ingress-db';
import { acceptSlackIngress, claimSlackIngress, readSlackIngress, completeSlackIngress, deferSlackIngress,
  renewSlackIngressLease, listRecoverableSlackIngress, updateLeasedIngress, type IngressLease, type FrozenIngressRoute } from './ingress-store';
const { test, run } = createTestRunner();

test('acceptance and producer ownership survive closed-fence duplicate', async () => {
  const f = ingressDbFixture();
  try {
    assert.deepEqual(await acceptSlackIngress(f.db, verifiedFixture(), { id: 'I1', now: 100 }), { status: 'accepted', id: 'I1', duplicate: false });
    f.closeIntake();
    assert.deepEqual(await acceptSlackIngress(f.db, verifiedFixture(), { id: 'I2', now: 101 }), { status: 'accepted', id: 'I1', duplicate: true });
    assert.equal(f.count('slack_ingress'), 1); assert.equal(f.count('cutover_producers'), 1);
    assert.deepEqual(await acceptSlackIngress(f.db, verifiedFixture('E2'), { id: 'I3' }), { status: 'closed' });
  } finally { f.dispose(); }
});
test('digest conflict preserves canonical event and ownership', async () => {
  const f = ingressDbFixture();
  try {
    await acceptSlackIngress(f.db, verifiedFixture(), { id: 'I1' });
    assert.deepEqual(await acceptSlackIngress(f.db, verifiedFixture('E1', 'b'.repeat(64))), { status: 'conflict' });
    assert.equal((await readSlackIngress(f.db, 'I1'))?.digest, 'a'.repeat(64));
    assert.equal(f.count('cutover_producers'), 1);
  } finally { f.dispose(); }
});
test('lost commit response repairs the original acceptance on retry', async () => {
  const f = ingressDbFixture();
  try {
    f.loseNextCommitResponse();
    await assert.rejects(() => acceptSlackIngress(f.db, verifiedFixture(), { id: 'I1' }));
    assert.deepEqual(await acceptSlackIngress(f.db, verifiedFixture(), { id: 'I2' }), { status: 'accepted', id: 'I1', duplicate: true });
    assert.equal(f.count('cutover_producers'), 1);
  } finally { f.dispose(); }
});
test('producer-trigger failure rolls back acceptance', async () => {
  const f = ingressDbFixture();
  try {
    f.sql.exec("INSERT INTO cutover_producers VALUES ('I1','slack','g2','intake',0)");
    await assert.rejects(() => acceptSlackIngress(f.db, verifiedFixture(), { id: 'I1' }));
    assert.equal(f.count('slack_ingress'), 0);
  } finally { f.dispose(); }
});
test('prepare lease excludes competing, stale and early claims', async () => {
  const f = ingressDbFixture();
  try {
    await acceptSlackIngress(f.db, verifiedFixture(), { id: 'I1', now: 100 });
    const first = await claimSlackIngress(f.db, 'I1', { owner: 'A', phase: 'prepare', now: 100, leaseMs: 60_000 });
    assert.ok(first);
    assert.equal(await claimSlackIngress(f.db, 'I1', { owner: 'B', phase: 'prepare', now: 101, leaseMs: 60_000 }), null);
    const next = await claimSlackIngress(f.db, 'I1', { owner: 'B', phase: 'prepare', now: 60_100, leaseMs: 60_000 });
    assert.equal(next?.revision, first.revision + 1);
    assert.equal((await readSlackIngress(f.db, 'I1'))?.prepare_attempts, 2);
  } finally { f.dispose(); }
});
test('invalid identities and unavailable control fail before accepted result', async () => {
  const f = ingressDbFixture();
  try {
    await assert.rejects(() => acceptSlackIngress(f.db, { ...verifiedFixture(), key: 'wrong' }));
    f.sql.exec('DELETE FROM cutover_control');
    await assert.rejects(() => acceptSlackIngress(f.db, verifiedFixture()));
    assert.equal(f.count('cutover_producers'), 0);
  } finally { f.dispose(); }
});
async function preparing(f: ReturnType<typeof ingressDbFixture>, id = 'I1') {
  await acceptSlackIngress(f.db, verifiedFixture(id), { id, now: 100 });
  const lease = (await claimSlackIngress(f.db, id, { now: 100, owner: 'A', leaseMs: 60_000, phase: 'prepare' }))!;
  const route: FrozenIngressRoute = { mode: 'quiet', deliveryEventId: `T:${id}`, epoch: 0,
    instanceId: null, target: null, binding: null, persona: null, skipAck: true };
  await updateLeasedIngress(f.db, lease, "target_json=?,mode='quiet',tracker_event_id=?,effects_complete=1,ack_state='skipped'",
    [JSON.stringify(route), route.deliveryEventId], 100);
  return { lease, route };
}
test('quiet completion atomically tombstones event and releases only its producer', async () => {
  const f = ingressDbFixture();
  try {
    const { lease } = await preparing(f);
    f.sql.exec("INSERT INTO cutover_producers VALUES ('other','slack','g2','intake',100)");
    assert.equal(await completeSlackIngress(f.db, lease, null, 101), true);
    const row = (await readSlackIngress(f.db, 'I1'))!;
    assert.equal(row.event_json, '{}'); assert.equal(row.content_retention, 'tombstoned');
    assert.equal(row.digest, 'a'.repeat(64)); assert.equal(f.count('cutover_producers'), 1);
    f.closeIntake();
    assert.equal((await acceptSlackIngress(f.db, verifiedFixture('I1'))).status, 'accepted');
    assert.throws(() => f.sql.prepare("UPDATE slack_ingress SET event_json='restored' WHERE id='I1'").run());
  } finally { f.dispose(); }
});
test('quiet completion with missing effects or producer rolls back content and state', async () => {
  for (const missing of ['effects','producer']) {
    const f = ingressDbFixture();
    try {
      const { lease } = await preparing(f);
      if (missing === 'effects') f.sql.exec("UPDATE slack_ingress SET effects_complete=0 WHERE id='I1'");
      else f.sql.exec("DELETE FROM cutover_producers WHERE id='I1'");
      await assert.rejects(() => completeSlackIngress(f.db, lease, null, 101));
      const row = (await readSlackIngress(f.db, 'I1'))!;
      assert.equal(row.state, 'preparing'); assert.notEqual(row.event_json, '{}');
      assert.equal(row.content_retention, 'retained');
    } finally { f.dispose(); }
  }
});
test('unfinished content and frozen route cannot be replaced', async () => {
  const f = ingressDbFixture();
  try {
    await preparing(f);
    assert.throws(() => f.sql.exec("UPDATE slack_ingress SET event_json='{}',content_retention='tombstoned'"));
    assert.throws(() => f.sql.exec("UPDATE slack_ingress SET digest='new'"));
    assert.throws(() => f.sql.exec("UPDATE slack_ingress SET target_json='{}'"));
    assert.equal(f.count('cutover_producers'), 1);
  } finally { f.dispose(); }
});
test('deferral honors due time, phase cap and stale renewal', async () => {
  const f = ingressDbFixture();
  try {
    const { lease } = await preparing(f);
    assert.equal(await deferSlackIngress(f.db, lease, 'ack-uncertain', 101, 120_101), true);
    assert.equal(await renewSlackIngressLease(f.db, lease, 102, 60_000), null);
    assert.deepEqual(await listRecoverableSlackIngress(f.db, 120_100, 8), []);
    assert.deepEqual(await listRecoverableSlackIngress(f.db, 120_101, 8), ['I1']);
    f.sql.exec("UPDATE slack_ingress SET prepare_attempts=8");
    assert.deepEqual(await listRecoverableSlackIngress(f.db, 120_101, 8), []);
    assert.equal(f.count('cutover_producers'), 1);
  } finally { f.dispose(); }
});
test('due-time ordering allows new records ahead of deferred older records', async () => {
  const f = ingressDbFixture();
  try {
    const { lease } = await preparing(f, 'old');
    await deferSlackIngress(f.db, lease, 'ack-uncertain', 101, 120_101);
    await acceptSlackIngress(f.db, verifiedFixture('new'), { id: 'new', now: 102 });
    assert.deepEqual(await listRecoverableSlackIngress(f.db, 120_102, 8), ['new','old']);
  } finally { f.dispose(); }
});
async function ready(f: ReturnType<typeof ingressDbFixture>): Promise<IngressLease> {
  await acceptSlackIngress(f.db, verifiedFixture(), { id: 'I1', now: 100 });
  const lease = (await claimSlackIngress(f.db, 'I1', { now: 100, owner: 'A', phase: 'prepare', leaseMs: 60_000 }))!;
  const target = { projectId: 'P', agentSlug: 'default', conversationId: 'conv', provider: 'slack',
    externalAccountId: 'T', externalSpaceId: 'C', externalConversationId: '1.0', transportTokenRef: 'TOKEN' };
  const route = { mode: 'engaged', instanceId: 'instance', deliveryEventId: 'T:E1', target, persona: null };
  await updateLeasedIngress(f.db, lease,
    "target_json=?,mode='engaged',instance_id='instance',tracker_event_id='T:E1',effects_complete=1,ack_state='skipped'", [JSON.stringify(route)], 100);
  f.sql.prepare("INSERT INTO slack_ingress_manifests VALUES ('M','I1',1,1,1,'d',100,'A',1)").run();
  f.sql.prepare("INSERT INTO slack_ingress_chunks VALUES ('M',0,?,'d')").run(new Uint8Array([123]));
  f.sql.exec("UPDATE slack_ingress SET state='ready',manifest_id='M',revision=revision+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=101");
  f.sql.prepare("INSERT INTO slack_reply_trackers(instance_id,event_id,target_json,publish,created_at,updated_at) VALUES ('instance','T:E1',?,1,100,100)").run(JSON.stringify(target));
  return (await claimSlackIngress(f.db, 'I1', { now: 102, owner: 'B', phase: 'handoff', leaseMs: 60_000 }))!;
}
const receipt = { submissionId: 'S', uid: 'UID', acceptedAt: '2026-10-04T00:00:00Z' };
test('native completion associates exact receipt and preserves advanced tracker status', async () => {
  const f = ingressDbFixture();
  try {
    const lease = await ready(f);
    f.sql.exec("UPDATE slack_reply_trackers SET status='delivered'");
    assert.equal(await completeSlackIngress(f.db, lease, receipt, 103), true);
    assert.equal(f.count('cutover_producers'), 0);
    assert.equal(f.sql.prepare('SELECT status FROM slack_reply_trackers').get()!.status, 'delivered');
    assert.equal(await completeSlackIngress(f.db, lease, { ...receipt, deduplicated: true }, 104), true);
  } finally { f.dispose(); }
});
for (const conflict of ['missing','target','persona','ack','publish','submission','uid','producer']) {
  test(`native completion rolls back association and retains producer for ${conflict} conflict`, async () => {
    const f = ingressDbFixture();
    try {
      const lease = await ready(f);
      if (conflict === 'missing') f.sql.exec('DELETE FROM slack_reply_trackers');
      else if (conflict === 'producer') f.sql.exec("UPDATE cutover_producers SET kind='drain'");
      else {
        const column = { target:'target_json',persona:'persona_json',ack:'ack_message_ts',publish:'publish',submission:'submission_id',uid:'uid' }[conflict]!;
        f.sql.prepare(`UPDATE slack_reply_trackers SET ${column}=?`).run(conflict === 'publish' ? 0 : conflict === 'persona' ? '{}' : 'wrong');
      }
      const before = f.sql.prepare('SELECT * FROM slack_reply_trackers').get();
      await assert.rejects(() => completeSlackIngress(f.db, lease, receipt, 103));
      assert.deepEqual(f.sql.prepare('SELECT * FROM slack_reply_trackers').get(), before);
      assert.equal((await readSlackIngress(f.db, 'I1'))!.state, 'ready');
      assert.equal(f.count('cutover_producers'), 1);
    } finally { f.dispose(); }
  });
}
test('stale native lease changes neither tracker nor producer', async () => {
  const f = ingressDbFixture();
  try {
    const old = await ready(f);
    await claimSlackIngress(f.db, 'I1', { now: 60_102, owner: 'C', phase: 'handoff', leaseMs: 60_000 });
    assert.equal(await completeSlackIngress(f.db, old, receipt, 60_103), false);
    assert.equal(f.sql.prepare('SELECT submission_id FROM slack_reply_trackers').get()!.submission_id, null);
    assert.equal(f.count('cutover_producers'), 1);
  } finally { f.dispose(); }
});
test('lost completion response recovers committed state without second release', async () => {
  const f = ingressDbFixture();
  try {
    const lease = await ready(f); f.loseNextCommitResponse();
    await assert.rejects(() => completeSlackIngress(f.db, lease, receipt, 103));
    assert.equal((await readSlackIngress(f.db, 'I1'))!.state, 'accepted');
    assert.equal(await completeSlackIngress(f.db, lease, receipt, 104), true);
    assert.equal(f.count('cutover_producers'), 0);
  } finally { f.dispose(); }
});
await run();
