import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { observeAssociatedInstance, readCutoverStatus, changeCutoverAdmissions } from './diagnostics';
import { ingressFixture } from './ingress-test-fixture';
import type { InventoryEntry } from './evidence';
import { idleFixture } from './evidence-test-fixture';
import { identityTestCases } from './identity-test-cases';
import { preparingIngressFixture, textRequest, removeFixtureGuards } from '../slack/test-utils/frozen-request';
import { storeFrozenRequest } from '../slack/frozen-request';
const { test, run } = createTestRunner();
identityTestCases(test);
const entry: InventoryEntry = { namespaceId: 'test-namespace', objectId: 'local-object', generation: 'g2', runtimeVersion: '2.2.2',
  associationEvidence: 'TEST DATA: known name derivation', instanceName: 'local@g2' };
for (const [name, value, namespace] of [
  ['beta runtime', { ...entry, generation: 'g1', runtimeVersion: '1.0.0-beta.1', instanceName: 'local@g1' }, 'test-namespace'],
  ['missing configured namespace', entry, undefined], ['wrong namespace', { ...entry, namespaceId: 'wrong' }, 'test-namespace'],
  ['opaque ID', { ...entry, instanceName: undefined }, 'test-namespace'], ['wrong suffix', { ...entry, instanceName: 'local@g1' }, 'test-namespace'],
] as const) test(`diagnostics reject ${name} before namespace access`, async () => {
  let calls = 0;
  const binding = new Proxy({}, { get() { calls++; throw new Error('object access forbidden'); } });
  const result = await observeAssociatedInstance({ CUTOVER_NAMESPACE_ID: namespace, FLUE_PROJECT_AGENT: binding }, 'g2', value) as any;
  assert.equal(result.status, 'unknown'); assert.equal(calls, 0);
});
test('matching name derives identity before diagnostic RPC without bootstrap', async () => {
  const calls: string[] = [];
  const result = await observeAssociatedInstance({ CUTOVER_NAMESPACE_ID: 'test-namespace', FLUE_PROJECT_AGENT: {
    idFromName(name: string) { calls.push(`derive:${name}`); return { toString: () => 'local-object' }; },
    idFromString(id: string) { calls.push(`id:${id}`); return id; },
    get(id: unknown) { calls.push(`get:${id}`); return { observeCutover: async (identity: unknown) => {
      calls.push('observe'); assert.deepEqual(identity, { namespaceId: 'test-namespace', objectId: 'local-object' });
      return { ...idleFixture().observations[0], objectId: 'local-object', status: 'blocked', blockers: ['active'] };
    }, setName() { throw new Error('bootstrap forbidden'); } }; },
  } }, 'g2', entry) as any;
  assert.equal(result.status, 'blocked');
  // Name is derived twice by design: once to verify the submitted ID matches, once
  // to obtain the PartyServer-correct name-addressed stub. idFromString is never used.
  assert.deepEqual(calls, ['derive:local@g2', 'derive:local@g2', 'get:local-object', 'observe']);
});
test('mismatched name ID never obtains a stub', async () => {
  let touched = false;
  const result = await observeAssociatedInstance({ CUTOVER_NAMESPACE_ID: 'test-namespace', FLUE_PROJECT_AGENT: {
    idFromName() { return { toString: () => 'wrong' }; }, get() { touched = true; throw new Error('forbidden'); },
  } }, 'g2', entry) as any;
  assert.equal(result.status, 'unknown'); assert.equal(touched, false);
});
test('missing RPC is unknown without leaking exception contents', async () => {
  const result = await observeAssociatedInstance({ CUTOVER_NAMESPACE_ID: 'test-namespace', FLUE_PROJECT_AGENT: {
    idFromName() { return { toString: () => 'local-object' }; }, idFromString() { return 'local-object'; },
    get() { throw new Error('private-error'); },
  } }, 'g2', entry) as any;
  assert.equal(result.status, 'unknown'); assert.ok(!JSON.stringify(result).includes('private-error'));
});
test('status aggregates required product obligations and closed control from real SQLite', async () => {
  const f = await ingressFixture();
  try {
    const result = await readCutoverStatus(f.env, 'g2', 20);
    assert.equal(result.controlState, 'closed'); assert.equal(result.producerCount, 0);
    assert.deepEqual(result.productCounts, { pendingMessages: 0, activeReceipts: 0, agentRuns: 0, workRuns: 0,
      notifications: 0, replyOutbox: 0, replyTrackers: 0, slackIngressPending: 0, slackIngressFailed: 0,
      slackIngressAckUncertain: 0, slackIngressStorageInvalid: 0 });
    assert.equal(result.observedAt, 20);
  } finally { f.dispose(); }
});
for (const table of ['pending_messages', 'agent_runs', 'slack_reply_trackers', 'slack_ingress', 'slack_ingress_manifests', 'slack_ingress_chunks']) test(`missing ${table} reports unknown, never zero`, async () => {
  const f = await ingressFixture();
  try { f.sql.exec(`DROP TABLE ${table}`); const result = await readCutoverStatus(f.env, 'g2');
    assert.equal(result.status, 'unknown'); assert.ok(result.unknowns.length);
  } finally { f.dispose(); }
});
test('admission control uses validated CAS and reports stale revisions', async () => {
  const f = await ingressFixture();
  try {
    assert.equal((await changeCutoverAdmissions(f.env, { state: 'open', expectedRevision: 0 })).status, 200);
    assert.equal(f.sql.prepare('SELECT state FROM cutover_control').get()!.state, 'open');
    assert.equal((await changeCutoverAdmissions(f.env, { state: 'closed', expectedRevision: 0 })).status, 409);
    assert.equal((await changeCutoverAdmissions(f.env, { state: 'closed', expectedRevision: -1 })).status, 400);
    assert.equal((await changeCutoverAdmissions(f.env, { state: 'closed', expectedRevision: 1, bypass: true })).status, 400);
  } finally { f.dispose(); }
});
test('unauthenticated cutover routes remain invisible', async () => {
  const f = await ingressFixture();
  try { for (const path of ['/__admin/cutover/status', '/__admin/cutover/instance', '/__admin/cutover/admissions']) {
    assert.equal((await f.internal(path, {})).status, 404);
  } } finally { await f.finishJobs(); f.dispose(); }
});
test('admin routes expose status and CAS without heartbeat authority', async () => {
  const f = await ingressFixture();
  try {
    const status = await f.adminStatus(); assert.equal(status.status, 200);
    assert.equal((await status.json() as any).controlState, 'closed');
    assert.equal((await f.admin('/__admin/cutover/admissions', { state: 'open', expectedRevision: 0 })).status, 200);
    assert.equal(f.sql.prepare('SELECT state FROM cutover_control').get()!.state, 'open');
    assert.equal((await f.admin('/__admin/cutover/instance', { ...entry, generation: 'g1', runtimeVersion: '1.0.0-beta.1' })).status, 200);
  } finally { await f.finishJobs(); f.dispose(); }
});
test('diagnostic RPC response must match identity and pinned runtime and retain startup limitation', async () => {
  const observation = { ...idleFixture().observations[0], objectId: 'local-object' };
  const env = (response: unknown) => ({ CUTOVER_NAMESPACE_ID: 'test-namespace', FLUE_PROJECT_AGENT: {
    idFromName: () => ({ toString: () => 'local-object' }), idFromString: () => 'local-object',
    get: () => ({ observeCutover: async () => response }),
  } });
  for (const response of [{ status: 'observed-idle' }, { ...observation, objectId: 'wrong' },
    { ...observation, generation: 'g1', runtimeVersion: '1.0.0-beta.1' }]) {
    assert.equal((await observeAssociatedInstance(env(response), 'g2', entry) as any).status, 'unknown');
  }
  const result = await observeAssociatedInstance(env(observation), 'g2', entry) as any;
  assert.equal(result.status, 'observed-idle');
  assert.ok(result.limitations.some((x: string) => x.includes('startup recovery')));
});
test('shape-rejected observation names the response as unacceptable, distinct from RPC failure', async () => {
  const observation = { ...idleFixture().observations[0], objectId: 'local-object', extraField: true };
  const env = { CUTOVER_NAMESPACE_ID: 'test-namespace', FLUE_PROJECT_AGENT: {
    idFromName: () => ({ toString: () => 'local-object' }), idFromString: () => 'local-object',
    get: () => ({ observeCutover: async () => observation }),
  } };
  const result = await observeAssociatedInstance(env, 'g2', entry) as any;
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.unknowns, ['instance observation response unacceptable']);
});
test('identity-mismatch throw classified separately from generic RPC failure', async () => {
  const stub = (error: unknown) => ({ CUTOVER_NAMESPACE_ID: 'test-namespace', FLUE_PROJECT_AGENT: {
    idFromName: () => ({ toString: () => 'local-object' }), idFromString: () => 'local-object',
    get: () => ({ observeCutover: async () => { throw error; } }),
  } });
  const mismatch = await observeAssociatedInstance(stub(new Error('object identity mismatch')), 'g2', entry) as any;
  assert.deepEqual(mismatch.unknowns, ['instance identity mismatch at object']);
  const generic = await observeAssociatedInstance(stub(new Error('private internals')), 'g2', entry) as any;
  assert.deepEqual(generic.unknowns, ['instance observation failed']);
  assert.ok(!JSON.stringify(generic).includes('private internals'));
});
test('native intake uncertainty and failed disposition remain blocking', async () => {
  const f = await ingressFixture();
  try {
    f.sql.prepare("INSERT INTO slack_ingress(id,team_id,event_id,digest,event_json,created_at,updated_at) VALUES('I','T','E',?,'{}',0,0)").run('a'.repeat(64));
    f.sql.exec("UPDATE slack_ingress SET ack_state='uncertain' WHERE id='I'");
    let result = await readCutoverStatus(f.env, 'g2');
    assert.equal(result.productCounts.slackIngressPending, 1);
    assert.equal(result.productCounts.slackIngressAckUncertain, 1);
    assert.equal(result.status, 'blocked');
    f.sql.exec("UPDATE slack_ingress SET state='failed',failure_category='storage-invalid' WHERE id='I'");
    result = await readCutoverStatus(f.env, 'g2');
    assert.equal(result.productCounts.slackIngressFailed, 1);
    assert.equal(result.productCounts.slackIngressStorageInvalid, 1);
    assert.equal(result.producerCount, 1);
  } finally { f.dispose(); }
});
test('beta observation does not require the new native intake tables', async () => {
  const f = await ingressFixture();
  try {
    f.sql.exec('DROP TABLE slack_ingress_chunks; DROP TABLE slack_ingress_manifests; DROP TABLE slack_ingress');
    const result = await readCutoverStatus(f.env, 'g1');
    assert.equal(result.status, 'observed-idle');
    assert.ok(!('slackIngressPending' in result.productCounts));
  } finally { f.dispose(); }
});
test('published BLOB hash corruption cannot produce a clean storage count', async () => {
  const f = await preparingIngressFixture();
  try {
    await storeFrozenRequest(f.db,f.lease,textRequest(),f.now);
    removeFixtureGuards(f);
    f.sql.exec("UPDATE slack_ingress_chunks SET bytes=zeroblob(length(bytes))");
    const result = await readCutoverStatus({DB:f.db,CUTOVER_CONTROL:'d1'},'g2');
    assert.equal(result.productCounts.slackIngressStorageInvalid,1);
    assert.equal(result.status,'blocked');
  } finally { f.dispose(); }
});
test('integrity scans stay bounded and report incomplete coverage for multiple outstanding payloads', async () => {
  const f = await preparingIngressFixture();
  try {
    await storeFrozenRequest(f.db,f.lease,textRequest(),f.now);
    removeFixtureGuards(f);
    f.sql.exec(`INSERT INTO slack_ingress(id,team_id,event_id,digest,event_json,state,revision,manifest_id,created_at,updated_at)
      SELECT 'I2',team_id,'E2',digest,event_json,state,revision,manifest_id,created_at,updated_at FROM slack_ingress WHERE id='I1'`);
    let blobs=0;
    const prepare = f.db.prepare.bind(f.db);
    f.db.prepare = query => { if(query.includes('SELECT ordinal,bytes,')) blobs++; return prepare(query); };
    const result = await readCutoverStatus({DB:f.db,CUTOVER_CONTROL:'d1'},'g2');
    assert.ok(result.unknowns.includes('ingress storage integrity coverage incomplete')); assert.equal(blobs,0);
    assert.equal(result.productCounts.slackIngressPending,2);
    assert.equal(result.productCounts.slackIngressStorageInvalid,1); // mismatched manifest ownership too
  } finally { f.dispose(); }
});
await run();
