import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { nativeObservationFixture } from './observation-test-fixtures';
import { readNativeObservation } from './native-observation';
import { evaluateCutoverEvidence } from './evidence';
import { idleFixture } from './evidence-test-fixture';
const { test, run } = createTestRunner();
const identity = { namespaceId: 'test-namespace', objectId: 'test-object' };
for (const status of ['queued', 'running', 'terminalizing', 'joining', 'joined']) {
  test(`native ${status} is never quiescent`, async () => {
    const f = nativeObservationFixture(); f.seedSubmission(status);
    const result = await readNativeObservation(f.storage, identity, 10);
    assert.equal(result.status, 'blocked'); assert.equal(result.nativeStatuses[status], 1);
    assert.ok(f.queries.every(q => /^(SELECT|PRAGMA)\b/i.test(q.trim())));
    assert.ok(!JSON.stringify(result).includes('private-payload')); f.sql.close();
  });
}
test('settled native records and retained completed fibers can be observed idle', async () => {
  const f = nativeObservationFixture(); f.seedSubmission('settled');
  f.sql.exec("INSERT INTO cf_agents_fibers(fiber_id,name,status,created_at,completed_at) VALUES('f','x','completed',1,2)");
  assert.equal((await readNativeObservation(f.storage, identity)).status, 'observed-idle'); f.sql.close();
});
for (const mutation of [
  "UPDATE flue_agent_submissions SET status='unexpected'",
  'UPDATE flue_agent_submissions SET settled_at=NULL',
  "UPDATE flue_meta SET value='99'", 'DELETE FROM flue_meta',
  "UPDATE flue_meta SET key='schema_version'", 'DROP TABLE flue_agent_submissions',
  'ALTER TABLE flue_agent_submissions RENAME COLUMN attempt_id TO missing',
]) {
  test(`native incompatible state is unknown: ${mutation}`, async () => {
    const f = nativeObservationFixture(); f.seedSubmission('settled'); f.sql.exec(mutation);
    assert.equal((await readNativeObservation(f.storage, identity)).status, 'unknown'); f.sql.close();
  });
}
test('uncapped counts find unfinished work after one thousand terminal records', async () => {
  const f = nativeObservationFixture(); for (let i = 0; i < 1001; i++) f.seedSubmission('settled', `s${i}`);
  f.seedSubmission('joined', 'follower');
  const result = await readNativeObservation(f.storage, identity);
  assert.equal(result.status, 'blocked'); assert.equal(result.counts.nativeSubmissions, 1002); f.sql.close();
});
test('settled errors are counted without exposing error content', async () => {
  const f = nativeObservationFixture(); f.seedSubmission('settled'); f.sql.exec("UPDATE flue_agent_submissions SET error='secret-error'");
  const result = await readNativeObservation(f.storage, identity);
  assert.equal(result.counts.nativeErrors, 1); assert.ok(!JSON.stringify(result).includes('secret-error')); f.sql.close();
});
test('physical alarm blocks even without SDK schedules', async () => {
  const f = nativeObservationFixture(); f.alarm(9);
  assert.equal((await readNativeObservation(f.storage, identity)).status, 'blocked'); f.sql.close();
});
test('destroy pending blocks matching-runtime observation', async () => {
  const f = nativeObservationFixture(); f.destroy(true);
  assert.equal((await readNativeObservation(f.storage, identity)).status, 'blocked'); f.sql.close();
});
for (const method of ['getAlarm', 'get'] as const) {
  test(`failed ${method} is unknown without leaked storage error`, async () => {
    const f = nativeObservationFixture(); f.storage[method] = async () => { throw new Error('private-storage-error'); };
    const result = await readNativeObservation(f.storage, identity);
    assert.equal(result.status, 'unknown'); assert.ok(!JSON.stringify(result).includes('private-storage-error')); f.sql.close();
  });
}
test('offline evidence accepts complete real native SQL observations including terminal records', async () => {
  const f = nativeObservationFixture();
  try {
    const evidence = idleFixture();
    for (const retained of [false, true]) {
      if (retained) {
        f.seedSubmission('settled');
        f.sql.exec("INSERT INTO cf_agents_fibers(fiber_id,name,status,created_at,completed_at) VALUES('f','x','completed',1,2)");
      }
      evidence.observations = [await readNativeObservation(f.storage, { namespaceId: 'test-namespace', objectId: 'object' }, 20)];
      assert.equal(evaluateCutoverEvidence(evidence, 30).status, 'observed-idle');
    }
  } finally { f.sql.close(); }
});
await run();
