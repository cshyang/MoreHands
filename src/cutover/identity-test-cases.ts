import assert from 'node:assert/strict';
import * as diagnostics from './diagnostics';
import { ingressFixture } from './ingress-test-fixture';
import type { TestFn } from '../shared/test-utils';

// A derivation must never instantiate an object, even for historical names.
export function identityTestCases(test: (name: string, fn: TestFn) => void) {
  const objectId = 'a'.repeat(64);
  const names = ['project:P:agent:default/conv:C', 'project:P:agent:default/conv:C@g1'];
  const derive = (env: unknown, input: unknown, now = 20) =>
    (diagnostics as any).deriveInstanceIdentities(env, input, now);
  const input = { namespaceId: 'test-namespace', instanceNames: names };
  test('identity derivation uses only idFromName and preserves exact historical names', async () => {
    const derived: string[] = [];
    const namespace = new Proxy({}, { get(_target, key) {
      assert.equal(key, 'idFromName', `forbidden namespace access: ${String(key)}`);
      return (name: string) => { derived.push(name); return { toString: () => objectId }; };
    } });
    const result = await derive({ CUTOVER_CONTROL: 'd1', CUTOVER_NAMESPACE_ID: 'test-namespace', FLUE_PROJECT_AGENT: namespace }, input);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.identities, names.map(instanceName => ({ instanceName, objectId })));
    assert.equal(result.body.namespaceId, 'test-namespace');
    assert.equal(result.body.observedAt, 20);
    assert.equal(result.body.runtimeVersion, undefined);
    assert.equal(result.body.generation, undefined);
    assert.deepEqual(derived, names);
    assert.ok(result.body.limitations.some((text: string) => text.includes('persisted runtime')));
  });
  for (const value of [null, {}, { ...input, namespaceId: 'other' }, { ...input, instanceNames: [] },
    { ...input, instanceNames: [''] }, { ...input, instanceNames: [' name '] },
    { ...input, instanceNames: ['bad\nname'] }, { ...input, instanceNames: [1] },
    { ...input, instanceNames: ['x'.repeat(1025)] }, { ...input, instanceNames: Array(101).fill('name') },
    { ...input, instanceNames: ['same', 'same'] }, { ...input, generation: 'g1' }]) {
    test(`invalid identity request rejects before namespace access: ${JSON.stringify(value).slice(0, 100)}`, async () => {
      const namespace = new Proxy({}, { get() { throw new Error('namespace must remain untouched'); } });
      const result = await derive({ CUTOVER_CONTROL: 'd1', CUTOVER_NAMESPACE_ID: 'test-namespace', FLUE_PROJECT_AGENT: namespace }, value);
      assert.equal(result.status, 400);
    });
  }
  for (const env of [{}, { CUTOVER_CONTROL: '' }, { CUTOVER_CONTROL: 'd1' },
    { CUTOVER_CONTROL: 'd1', CUTOVER_NAMESPACE_ID: ' ' },
    { CUTOVER_CONTROL: 'd1', CUTOVER_NAMESPACE_ID: 'test-namespace' }]) {
    test(`unavailable derivation configuration fails closed: ${JSON.stringify(env)}`, async () => {
      assert.equal((await derive(env, input)).status, 503);
    });
  }
  test('derivation failure returns no partial mapping or private exception', async () => {
    let calls = 0;
    const result = await derive({ CUTOVER_CONTROL: 'd1', CUTOVER_NAMESPACE_ID: 'test-namespace', FLUE_PROJECT_AGENT: {
      idFromName() { if (++calls === 2) throw new Error('private failure'); return { toString: () => objectId }; },
    } }, input);
    assert.equal(result.status, 503);
    assert.equal(result.body.identities, undefined);
    assert.ok(!JSON.stringify(result).includes('private failure'));
  });
  test('malformed derived object ID is unavailable, never accepted as an association', async () => {
    const result = await derive({ CUTOVER_CONTROL: 'd1', CUTOVER_NAMESPACE_ID: 'test-namespace', FLUE_PROJECT_AGENT: {
      idFromName() { return { toString: () => 'not-an-object-id' }; },
    } }, input);
    assert.equal(result.status, 503);
  });
  test('authenticated identity route derives without product effects or producer admission', async () => {
    const f = await ingressFixture();
    try {
      const derived: string[] = [];
      Object.assign(f.env, { CUTOVER_NAMESPACE_ID: 'test-namespace', FLUE_PROJECT_AGENT: new Proxy({}, { get(_target, key) {
        assert.equal(key, 'idFromName');
        return (name: string) => { derived.push(name); return { toString: () => objectId }; };
      } }) });
      assert.equal((await f.internal('/__admin/cutover/identities', input)).status, 404);
      assert.deepEqual(derived, []);
      const response = await f.admin('/__admin/cutover/identities', input);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json() as any).identities, names.map(instanceName => ({ instanceName, objectId })));
      assert.deepEqual(derived, names);
      assert.deepEqual(f.effects, []);
      await f.finishJobs();
      assert.equal(f.count(), 0);
    } finally { f.dispose(); }
  });
  test('approved failed disposition settles outstanding notifications without misclassifying fresh pending', async () => {
    const f = await ingressFixture();
    try {
      const { readCutoverStatus } = await import('./diagnostics');
      // The 17 historical rows were marked failed with the approved cutover-disposition error.
      f.sql.exec(`INSERT INTO agent_run_notifications(id,project_id,run_id,channel,notification_type,dedupe_key,status,error,created_at)
        VALUES ('n1','P','r1','linear','completed','d1','failed','cutover disposition: historical notification not delivered',1)`);
      // A failed row WITHOUT the disposition marker stays an outstanding obligation.
      f.sql.exec(`INSERT INTO agent_run_notifications(id,project_id,run_id,channel,notification_type,dedupe_key,status,error,created_at)
        VALUES ('n2','P','r1','linear','failed','d2','failed','runner timeout',2)`);
      const before = await readCutoverStatus(f.env, 'g2', 30);
      assert.equal(before.productCounts.notifications, 1);
      assert.deepEqual(before.blockers, ['product obligation: notifications']);
      f.sql.exec(`UPDATE agent_run_notifications SET error='cutover disposition: historical notification not delivered' WHERE id='n2'`);
      const after = await readCutoverStatus(f.env, 'g2', 40);
      assert.equal(after.productCounts.notifications, 0);
      assert.deepEqual(after.blockers, []);
      assert.equal(after.status, 'observed-idle');
    } finally { f.dispose(); }
  });
}
