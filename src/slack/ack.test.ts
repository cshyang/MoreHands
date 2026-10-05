// Slack working acknowledgement invariants — run: npx tsx src/slack/ack.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { postWorkingAck, pickWorkingAck, WORKING_ACKS } from './ack';

const { test, run } = createTestRunner();

test('postWorkingAck: posts the default ack and returns its ts (for later edit-in-place)', async () => {
  const calls: Array<{ token: string; channel: string; text: string; threadTs?: string }> = [];

  const ts = await postWorkingAck(
    { token: 'xoxb-test', channel: 'C1', threadTs: '111.222' },
    {
      postMessage: async (token, channel, text, threadTs) => {
        calls.push({ token, channel, text, threadTs });
        return '333.444';
      },
    },
  );

  assert.equal(ts, '333.444');
  assert.equal(calls.length, 1);
  assert.deepEqual({ token: calls[0].token, channel: calls[0].channel, threadTs: calls[0].threadTs }, { token: 'xoxb-test', channel: 'C1', threadTs: '111.222' });
  assert.ok(WORKING_ACKS.includes(calls[0].text), `default ack comes from the pool (got "${calls[0].text}")`);
});

test('pickWorkingAck: covers the whole pool and never escapes it', () => {
  assert.equal(pickWorkingAck(() => 0), WORKING_ACKS[0]);
  assert.equal(pickWorkingAck(() => 0.999999), WORKING_ACKS[WORKING_ACKS.length - 1]);
  const seen = new Set<string>();
  for (let i = 0; i < WORKING_ACKS.length; i++) seen.add(pickWorkingAck(() => i / WORKING_ACKS.length));
  assert.equal(seen.size, WORKING_ACKS.length, 'a uniform sweep hits every line');
});

test('postWorkingAck: returns undefined and posts nothing when no token is available', async () => {
  let called = 0;

  const ts = await postWorkingAck(
    { channel: 'C1', threadTs: '111.222' },
    {
      postMessage: async () => {
        called++;
        return 'x';
      },
    },
  );

  assert.equal(ts, undefined);
  assert.equal(called, 0);
});

test('postWorkingAck: times out and returns undefined so a hung Slack never blocks dispatch', async () => {
  const logs: string[] = [];

  const ts = await postWorkingAck(
    { token: 'xoxb-test', channel: 'C1', threadTs: '111.222' },
    {
      postMessage: () => new Promise<string>(() => {}), // never resolves
      log: (message) => logs.push(message),
      timeoutMs: 10,
    },
  );

  assert.equal(ts, undefined);
  assert.ok(logs.some((l) => l.includes('timed out')));
});

test('postWorkingAck: swallows send failures, logs, and returns undefined (turn never blocks)', async () => {
  const logs: string[] = [];

  const ts = await postWorkingAck(
    { token: 'xoxb-test', channel: 'C1', threadTs: '111.222' },
    {
      postMessage: async () => {
        throw new Error('Slack down');
      },
      log: (message) => logs.push(message),
    },
  );

  assert.equal(ts, undefined);
  assert.deepEqual(logs, ['[ack] working-ack failed to post: Slack down']);
});

// Losing raw-promise tracking would release the fence at the timeout or hide a late rejection.
for (const rejects of [false, true]) {
  test(`ack timeout retains producer until raw post ${rejects ? 'rejects' : 'settles'}`, async () => {
    const { sqliteD1, readMigration, deferred } = await import('../cutover/test-fixtures');
    const { beginIntake, setAdmissionState } = await import('../cutover/admissions');
    const { createProducerScope } = await import('../cutover/producer');
    const f = sqliteD1();
    f.sql.exec(readMigration('0032_cutover_control.sql'));
    await setAdmissionState(f.db, 0, 'open');
    const env = { DB: f.db, CUTOVER_CONTROL: 'd1' };
    const scope = createProducerScope(env, await beginIntake(env, 'g2', 'slack'));
    const post = deferred<string>();
    assert.equal(await postWorkingAck({ token: 'test', channel: 'C', threadTs: '1' }, {
      postMessage: () => post.promise, timeoutMs: 1, log() {},
      trackPost: promise => { scope.track(promise); },
    }), undefined);
    const finishing = scope.finish(true);
    await Promise.resolve();
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM cutover_producers').get()!.n, 1);
    if (rejects) post.reject(new Error('late network failure'));
    else post.resolve('2');
    await finishing;
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM cutover_producers').get()!.n, rejects ? 1 : 0);
    f.sql.close();
  });
}

await run();
