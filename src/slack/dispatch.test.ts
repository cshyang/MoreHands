// Slack dispatch fallback invariants — run: npx tsx src/slack/dispatch.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { claimEvent, type KVLike } from '../shared/idempotency';
import { SETUP_FAILURE_FALLBACK } from './ack';
import { dispatchSlackTurnWithFallback } from './dispatch';
import { ProjectAdmissionError } from '../gateway/dispatch-message';

const { test, run } = createTestRunner();

test('dispatchSlackTurnWithFallback posts one safe failure message after dispatch throws', async () => {
  const waits: Promise<unknown>[] = [];
  const posts: Array<{ token: string; channel: string; text: string; threadTs?: string }> = [];
  const logs: string[] = [];

  const result = await dispatchSlackTurnWithFallback(
    { agent: 'project', id: 'project:project_1:agent:default', input: { message: 'setup' } },
    {
      executionCtx: { waitUntil: (promise) => waits.push(promise) },
      token: 'xoxb-test',
      channel: 'C1',
      threadTs: '111.222',
    },
    {
      dispatch: async () => {
        throw new ProjectAdmissionError('dispatch failed');
      },
      postMessage: async (token, channel, text, threadTs) => {
        posts.push({ token, channel, text, threadTs });
      },
      log: (message) => logs.push(message),
    },
  );

  assert.equal(result.dispatched, false);
  assert.equal(waits.length, 1);
  await waits[0];
  assert.deepEqual(posts, [{ token: 'xoxb-test', channel: 'C1', text: SETUP_FAILURE_FALLBACK, threadTs: '111.222' }]);
  assert.deepEqual(logs, ['[slack] agent dispatch failed after working ack: dispatch failed']);
});

test('Slack idempotency keeps the setup failure fallback from double-posting on retry', async () => {
  const seen = new Set<string>();
  const kv: KVLike = {
    async get(key) {
      return seen.has(key) ? '1' : null;
    },
    async put(key) {
      seen.add(key);
    },
  };
  const waits: Promise<unknown>[] = [];
  let posts = 0;

  for (let i = 0; i < 2; i++) {
    if (!(await claimEvent(kv, 'Ev123'))) continue;
    await dispatchSlackTurnWithFallback(
      { agent: 'project', id: 'project:project_1:agent:default', input: { message: 'setup' } },
      {
        executionCtx: { waitUntil: (promise) => waits.push(promise) },
        token: 'xoxb-test',
        channel: 'C1',
        threadTs: '111.222',
      },
      {
        dispatch: async () => {
          throw new ProjectAdmissionError('dispatch failed');
        },
        postMessage: async () => {
          posts++;
        },
        log: () => {},
      },
    );
  }

  await Promise.all(waits);
  assert.equal(posts, 1);
});

test('native admission passes its receipt to tracking and bookkeeping failure never posts fallback', async () => {
  const waits: Promise<unknown>[] = [];
  let tracked: unknown;
  let posts = 0;
  const receipt = { submissionId: 'sub-one', uid: 'instance-one', acceptedAt: '2026-10-01T00:00:00Z' };
  const result = await dispatchSlackTurnWithFallback(
    { id: 'project:P:agent:default/conv:C', input: { message: 'first' }, idempotencyKey: 'slack:Ev1' },
    { executionCtx: { waitUntil: (promise) => waits.push(promise) }, token: 'x', channel: 'C', threadTs: '1.0' },
    {
      dispatch: async (request) => { assert.equal(request.idempotencyKey, 'slack:Ev1'); return receipt; },
      onAccepted: async (value) => { tracked = value; throw new Error('D1 unavailable'); },
      postMessage: async () => { posts++; },
      log: () => {},
    },
  );
  assert.equal(result.dispatched, true);
  assert.equal(tracked, receipt);
  await Promise.all(waits);
  assert.equal(posts, 0);
});

test('definite local rejection closes tracking; uncertain native acceptance stays recoverable', async () => {
  for (const definite of [true, false]) {
    let rejected = 0;
    const waits: Promise<unknown>[] = [];
    const result = await dispatchSlackTurnWithFallback(
      { id: 'i', input: { message: 'first' } },
      { executionCtx: { waitUntil: (promise) => waits.push(promise) }, token: 'x', channel: 'C', threadTs: '1' },
      { dispatch: async () => { throw definite ? new ProjectAdmissionError('context failed') : new Error('DO response lost'); },
        onRejected: async () => { rejected++; }, postMessage: async () => {}, log: () => {} },
    );
    assert.equal(result.dispatched, false);
    assert.equal(rejected, definite ? 1 : 0);
    assert.equal(waits.length, definite ? 1 : 0);
    await Promise.all(waits);
  }
});

await run();
