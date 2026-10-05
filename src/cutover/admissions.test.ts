import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { sqliteD1, deferred, readMigration } from './test-fixtures';
import { AdmissionUnavailable, beginIntake, beginDrain, releaseAdmission, setAdmissionState } from './admissions';
import { createProducerScope } from './producer';
import type { D1Like } from '../skills/repository';

const { test, run } = createTestRunner();
function fixture() {
  const f = sqliteD1();
  f.sql.exec(readMigration('0032_cutover_control.sql'));
  const env = { DB: f.db, CUTOVER_CONTROL: 'd1' };
  const count = () => Number(f.sql.prepare('SELECT COUNT(*) AS n FROM cutover_producers').get()!.n);
  return { ...f, env, count };
}

// Dropping the conditional INSERT or releasing on response completion breaks these tests.
test('initially closed control rejects intake without registering work', async () => {
  const f = fixture();
  await assert.rejects(beginIntake(f.env, 'g2', 'slack', 'closed'), AdmissionUnavailable);
  assert.equal(f.count(), 0);
});
test('registration before closure survives until its deferred child settles', async () => {
  const f = fixture();
  assert.equal(await setAdmissionState(f.db, 0, 'open', 1), true);
  const admission = await beginIntake(f.env, 'g2', 'linear', 'before', 2);
  assert.ok(admission);
  assert.equal(await setAdmissionState(f.db, 1, 'closed', 3), true);
  await assert.rejects(beginIntake(f.env, 'g2', 'slack', 'after', 4), AdmissionUnavailable);
  assert.equal(f.count(), 1);
  const child = deferred<void>();
  const scope = createProducerScope(f.env, admission);
  assert.equal(scope.track(child.promise), child.promise);
  const finishing = scope.finish(true);
  await Promise.resolve();
  assert.equal(f.count(), 1);
  child.resolve();
  await finishing;
  assert.equal(f.count(), 0);
});
test('closure ordered first prevents a subsequent registration', async () => {
  const f = fixture();
  await setAdmissionState(f.db, 0, 'open');
  await setAdmissionState(f.db, 1, 'closed');
  await assert.rejects(beginIntake(f.env, 'g1', 'slack', 'late'), AdmissionUnavailable);
  assert.equal(f.count(), 0);
});
test('only absent configuration retains ordinary intake behavior', async () => {
  assert.equal(await beginIntake({}, 'g2', 'slack'), null);
  assert.equal(await beginDrain({}, 'g1', 'accepted-runs'), null);
  await createProducerScope({}, null).finish(true);
  for (const value of ['', null, false, 1, 'D1', 'open', {}]) {
    await assert.rejects(beginIntake({ CUTOVER_CONTROL: value }, 'g2', 'slack'), AdmissionUnavailable);
  }
});
test('enabled mode rejects missing database, schema, or control row', async () => {
  await assert.rejects(beginIntake({ CUTOVER_CONTROL: 'd1' }, 'g2', 'slack'), AdmissionUnavailable);
  const empty = sqliteD1();
  await assert.rejects(beginIntake({ DB: empty.db, CUTOVER_CONTROL: 'd1' }, 'g2', 'slack'), AdmissionUnavailable);
  const f = fixture();
  f.sql.exec('DELETE FROM cutover_control');
  await assert.rejects(beginIntake(f.env, 'g2', 'slack'), AdmissionUnavailable);
  await assert.rejects(beginDrain(f.env, 'g2', 'accepted-runs'), AdmissionUnavailable);
});
test('database errors are redacted and never fall back to open', async () => {
  const db: D1Like = { prepare() { throw new Error('private-database-content'); } };
  await assert.rejects(beginIntake({ DB: db, CUTOVER_CONTROL: 'd1' }, 'g2', 'slack'), error => {
    assert.ok(error instanceof AdmissionUnavailable);
    assert.ok(!error.message.includes('private-database-content'));
    return true;
  });
});
test('unknown D1 write result never proves a registration', async () => {
  const f = fixture();
  await setAdmissionState(f.db, 0, 'open');
  const db: D1Like = { prepare: query => ({ bind: (...values) => {
    const actual = f.db.prepare(query).bind(...values);
    return { ...actual, run: async () => { await actual.run(); return {}; } };
  } }) };
  await assert.rejects(beginIntake({ DB: db, CUTOVER_CONTROL: 'd1' }, 'g2', 'slack', 'ambiguous'), AdmissionUnavailable);
  assert.equal(f.count(), 1); // The write might have happened; retain the blocker.
});
test('stale control revision cannot reopen admissions', async () => {
  const f = fixture();
  assert.equal(await setAdmissionState(f.db, 0, 'open', 1), true);
  assert.equal(await setAdmissionState(f.db, 0, 'closed', 2), false);
  const row = f.sql.prepare('SELECT state,revision,updated_at FROM cutover_control').get()!;
  assert.deepEqual({ ...row }, { state: 'open', revision: 1, updated_at: 1 });
});
test('accepted recovery may register while closed but invalid control cannot', async () => {
  const f = fixture();
  const admission = await beginDrain(f.env, 'g1', 'parked-messages', 'drain', 1);
  assert.ok(admission);
  assert.equal(f.sql.prepare('SELECT kind FROM cutover_producers').get()!.kind, 'drain');
  await releaseAdmission(f.db, admission);
  assert.equal(f.count(), 0);
  f.sql.exec('PRAGMA ignore_check_constraints=ON; UPDATE cutover_control SET state=\'corrupt\'');
  await assert.rejects(beginDrain(f.env, 'g1', 'accepted-runs'), AdmissionUnavailable);
});
test('failed producer preserves durable registration without expiry', async () => {
  const f = fixture();
  await setAdmissionState(f.db, 0, 'open');
  const admission = await beginIntake(f.env, 'g2', 'slack', 'failed', 1);
  await createProducerScope(f.env, admission).finish(false);
  await setAdmissionState(f.db, 1, 'closed', 1e12);
  assert.equal(f.count(), 1);
  await assert.rejects(beginIntake(f.env, 'g2', 'slack', 'later', 1e12), AdmissionUnavailable);
  assert.equal(f.count(), 1);
});
test('child rejection remains visible and blocks release even when caller catches it', async () => {
  const f = fixture();
  await setAdmissionState(f.db, 0, 'open');
  const admission = await beginIntake(f.env, 'g2', 'slack', 'child-failed');
  const scope = createProducerScope(f.env, admission);
  const child = deferred<void>();
  const original = scope.track(child.promise);
  child.reject(new Error('network failed'));
  await assert.rejects(original, /network failed/);
  await scope.finish(true);
  assert.equal(f.count(), 1);
});
test('finish includes a child registered by an already-tracked parent', async () => {
  const f = fixture();
  await setAdmissionState(f.db, 0, 'open');
  const scope = createProducerScope(f.env, await beginIntake(f.env, 'g2', 'linear', 'nested'));
  const parent = deferred<void>();
  const child = deferred<void>();
  scope.track(parent.promise.then(() => { scope.track(child.promise); }));
  const finishing = scope.finish(true);
  parent.resolve();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.count(), 1);
  child.resolve();
  await finishing;
  assert.equal(f.count(), 0);
  assert.throws(() => scope.track(Promise.resolve()), /finished/);
});
test('release cannot remove another source or generation registration', async () => {
  const f = fixture();
  await setAdmissionState(f.db, 0, 'open');
  const admission = await beginIntake(f.env, 'g1', 'slack', 'exact');
  assert.ok(admission);
  await assert.rejects(releaseAdmission(f.db, { ...admission, generation: 'g2' }), AdmissionUnavailable);
  assert.equal(f.count(), 1);
  await releaseAdmission(f.db, admission);
  assert.equal(f.count(), 0);
});
test('release failure preserves marker rather than silently reporting success', async () => {
  const f = fixture();
  await setAdmissionState(f.db, 0, 'open');
  const admission = await beginIntake(f.env, 'g2', 'slack', 'release');
  const db: D1Like = { prepare(query) {
    if (query.startsWith('DELETE')) throw new Error('database unavailable');
    return f.db.prepare(query);
  } };
  await assert.rejects(createProducerScope({ ...f.env, DB: db }, admission).finish(true), AdmissionUnavailable);
  assert.equal(f.count(), 1);
});
test('repeated finish cannot upgrade failed producer into successful release', async () => {
  const f = fixture();
  await setAdmissionState(f.db, 0, 'open');
  const scope = createProducerScope(f.env, await beginIntake(f.env, 'g2', 'slack', 'repeat'));
  await scope.finish(false);
  await scope.finish(true);
  assert.equal(f.count(), 1);
});

await run();
