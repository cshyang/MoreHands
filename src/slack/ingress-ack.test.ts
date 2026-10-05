// Durable acknowledgement invariants — run: npx tsx src/slack/ingress-ack.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { ingressDbFixture, verifiedFixture } from './test-utils/ingress-db';
import {
  acceptSlackIngress,
  claimSlackIngress,
  deferSlackIngress,
  readSlackIngress,
  updateLeasedIngress,
  type IngressLease,
} from './ingress-store';
import { interceptDb } from './test-utils/frozen-request';
import { ensureIngressAck, type DurableAckInput } from './ingress-ack';

const { test, run } = createTestRunner();

const baseInput: DurableAckInput = {
  ingressId: 'I1',
  token: 'fake-slack-token',
  channel: 'C1',
  threadTs: '100.0',
  oldestTs: '100.0',
  text: 'On it',
  persona: null,
  botId: 'U1',
  appId: 'A1',
};

function input(overrides: Partial<DurableAckInput> = {}): DurableAckInput {
  return { ...baseInput, ...overrides };
}

function frozenAckJson(overrides: Partial<DurableAckInput> = {}): string {
  const value = input(overrides);
  return JSON.stringify({
    channel: value.channel,
    threadTs: value.threadTs ?? null,
    oldestTs: value.oldestTs,
    text: value.text,
    persona: value.persona,
    botId: value.botId ?? null,
    appId: value.appId ?? null,
    deliveryId: `ingress-ack:${value.ingressId}`,
  });
}

async function fixture(id = 'I1') {
  const f = ingressDbFixture();
  await acceptSlackIngress(f.db, verifiedFixture(), { id, now: 100 });
  const lease = (await claimSlackIngress(f.db, id, {
    now: 100, owner: 'A', leaseMs: 60_000, phase: 'prepare',
  }))!;
  assert.ok(lease);
  return { f, lease };
}

async function withFetch<T>(replacement: typeof fetch, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

function isPost(url: string | URL | Request): boolean {
  return new URL(String(url)).pathname === '/api/chat.postMessage';
}

interface AckHistoryMessage {
  ts: string;
  subtype: string;
  channel?: string;
  thread_ts?: string;
  user?: string;
  app_id: string;
  metadata: { event_type: string; event_payload: { delivery_id: string } };
}

function metadataMessage(overrides: Partial<AckHistoryMessage> = {}): AckHistoryMessage {
  return {
    ts: '101.0',
    subtype: 'bot_message',
    app_id: 'A1',
    metadata: { event_type: 'morehands_reply', event_payload: { delivery_id: 'ingress-ack:I1' } },
    ...overrides,
  };
}

function historyResponse(message: AckHistoryMessage = metadataMessage()) {
  return Response.json({ ok: true, messages: [message] });
}

async function seedAckState(
  f: ReturnType<typeof ingressDbFixture>,
  lease: IngressLease,
  state: 'sending' | 'uncertain',
): Promise<void> {
  await updateLeasedIngress(f.db, lease, 'ack_state=\'intent\',ack_json=?', [frozenAckJson()], 100);
  await updateLeasedIngress(f.db, lease, `ack_state='${state}'`, [], 100);
}

test('acknowledgement requires the input id to equal the live lease id', async () => {
  const { f, lease } = await fixture();
  try {
    let calls = 0;
    await withFetch(async () => { calls++; throw new Error('network must not start'); }, async () => {
      await assert.rejects(
        ensureIngressAck(f.db, lease, input({ ingressId: 'other' }), 100),
        /Ack lease identity conflict/,
      );
    });
    const row = (await readSlackIngress(f.db, 'I1'))!;
    assert.equal(row.ack_state, 'none');
    assert.equal(row.ack_json, null);
    assert.equal(calls, 0);
  } finally {
    f.dispose();
  }
});

test('missing token skips an unfrozen row without a network call or frozen route', async () => {
  const { f, lease } = await fixture();
  try {
    assert.equal((await readSlackIngress(f.db, 'I1'))?.target_json, null);
    let calls = 0;
    const result = await withFetch(async () => { calls++; throw new Error('network must not start'); }, () =>
      ensureIngressAck(f.db, lease, input({ token: undefined }), 100));

    assert.deepEqual(result, { status: 'skipped' });
    const row = (await readSlackIngress(f.db, 'I1'))!;
    assert.equal(row.ack_state, 'skipped');
    assert.deepEqual(JSON.parse(row.ack_json!), { reason: 'missing-token' });
    assert.equal(calls, 0);
  } finally {
    f.dispose();
  }
});

test('a lost post response repairs from positive app metadata without reposting', async () => {
  const { f, lease } = await fixture();
  try {
    let posts = 0;
    let lookups = 0;
    const result = await withFetch(async (url) => {
      if (isPost(url)) {
        posts++;
        throw new Error('post response lost after Slack accepted it');
      }
      lookups++;
      return historyResponse();
    }, async () => {
      const uncertain = await ensureIngressAck(f.db, lease, input(), 100);
      assert.deepEqual(uncertain, { status: 'uncertain' });
      return ensureIngressAck(f.db, lease, input(), 101);
    });

    assert.deepEqual(result, { status: 'posted', ts: '101.0' });
    const row = (await readSlackIngress(f.db, 'I1'))!;
    assert.equal(row.ack_state, 'posted');
    assert.equal(row.ack_message_ts, '101.0');
    assert.equal(posts, 1);
    assert.equal(lookups, 1);
  } finally {
    f.dispose();
  }
});

test('missing metadata never authorizes a second acknowledgement post', async () => {
  const { f, lease } = await fixture();
  try {
    let posts = 0;
    let lookups = 0;
    const result = await withFetch(async (url) => {
      if (isPost(url)) {
        posts++;
        throw new Error('post response lost');
      }
      lookups++;
      return Response.json({ ok: true, messages: [] });
    }, async () => {
      await ensureIngressAck(f.db, lease, input(), 100);
      return ensureIngressAck(f.db, lease, input(), 101);
    });

    assert.deepEqual(result, { status: 'uncertain' });
    const row = (await readSlackIngress(f.db, 'I1'))!;
    assert.equal(row.ack_state, 'uncertain');
    assert.equal(row.ack_message_ts, null);
    assert.equal(posts, 1);
    assert.equal(lookups, 1);
  } finally {
    f.dispose();
  }
});

test('a crash after persisting sending performs lookup only and never posts', async () => {
  const { f, lease } = await fixture();
  try {
    await seedAckState(f, lease, 'sending');
    let posts = 0;
    let lookups = 0;
    const result = await withFetch(async (url) => {
      if (isPost(url)) {
        posts++;
        throw new Error('posting is forbidden after a sending crash');
      }
      lookups++;
      return Response.json({ ok: true, messages: [] });
    }, () => ensureIngressAck(f.db, lease, input(), 101));

    assert.deepEqual(result, { status: 'uncertain' });
    const row = (await readSlackIngress(f.db, 'I1'))!;
    assert.equal(row.ack_state, 'uncertain');
    assert.equal(posts, 0);
    assert.equal(lookups, 1);
  } finally {
    f.dispose();
  }
});

test('JSON-less 429 returns to intent and a due fresh lease posts once successfully', async () => {
  const { f, lease } = await fixture();
  try {
    let attempts = 0;
    let successes = 0;
    const rejection = await withFetch(async (url) => {
      if (!isPost(url)) throw new Error('lookup not expected');
      attempts++;
      return new Response('', { status: 429, headers: { 'retry-after': '2' } });
    }, () => ensureIngressAck(f.db, lease, input(), 100));

    assert.deepEqual(rejection, { status: 'retryable-rejection', retryAfterMs: 2_000 });
    const intentRow = (await readSlackIngress(f.db, 'I1'))!;
    assert.equal(intentRow.ack_state, 'intent');
    assert.equal(intentRow.ack_json, frozenAckJson());

    assert.equal(await deferSlackIngress(f.db, lease, 'ack-rate-limited', 101, 102_000), true);
    const fresh = (await claimSlackIngress(f.db, 'I1', {
      now: 102_000, owner: 'recovery', leaseMs: 60_000, phase: 'prepare',
    }))!;
    assert.ok(fresh);

    const posted = await withFetch(async (url) => {
      if (!isPost(url)) throw new Error('lookup not expected');
      attempts++;
      successes++;
      return Response.json({ ok: true, ts: '102.0' });
    }, () => ensureIngressAck(f.db, fresh, input(), 102_000));

    assert.deepEqual(posted, { status: 'posted', ts: '102.0' });
    const row = (await readSlackIngress(f.db, 'I1'))!;
    assert.equal(row.ack_state, 'posted');
    assert.equal(row.ack_message_ts, '102.0');
    assert.equal(row.ack_json, frozenAckJson());
    assert.equal(attempts, 2);
    assert.equal(successes, 1);
  } finally {
    f.dispose();
  }
});

test('a lost 429 transport response remains uncertain', async () => {
  const { f, lease } = await fixture();
  try {
    const result = await withFetch(async () => {
      throw new Error('429 response lost before status was observed');
    }, () => ensureIngressAck(f.db, lease, input(), 100));

    assert.deepEqual(result, { status: 'uncertain' });
    const row = (await readSlackIngress(f.db, 'I1'))!;
    assert.equal(row.ack_state, 'uncertain');
    assert.equal(row.ack_message_ts, null);
  } finally {
    f.dispose();
  }
});

test('a permanent Slack rejection is retained as rejected', async () => {
  const { f, lease } = await fixture();
  try {
    let posts = 0;
    const result = await withFetch(async (url) => {
      if (!isPost(url)) throw new Error('lookup not expected');
      posts++;
      return Response.json({ ok: false, error: 'channel_not_found' });
    }, () => ensureIngressAck(f.db, lease, input(), 100));

    assert.deepEqual(result, { status: 'rejected' });
    const row = (await readSlackIngress(f.db, 'I1'))!;
    assert.equal(row.ack_state, 'rejected');
    assert.equal(row.ack_message_ts, null);
    assert.equal(posts, 1);
  } finally {
    f.dispose();
  }
});

test('scope, time, user, and app mismatches cannot repair an uncertain ack', async () => {
  const cases: Array<[string, Partial<AckHistoryMessage>]> = [
    ['wrong channel', { channel: 'other' }],
    ['wrong thread', { thread_ts: '99.0' }],
    ['before inclusive oldest', { ts: '99.999' }],
    ['wrong configured user', { user: 'U2', app_id: 'A1' }],
    ['wrong app for userless persona', { app_id: 'A2' }],
  ];

  for (const [name, message] of cases) {
    const { f, lease } = await fixture();
    try {
      await seedAckState(f, lease, 'uncertain');
      let posts = 0;
      const result = await withFetch(async (url) => {
        if (isPost(url)) {
          posts++;
          throw new Error('mismatched metadata must not authorize a post');
        }
        return historyResponse(metadataMessage(message));
      }, () => ensureIngressAck(f.db, lease, input(), 101));

      assert.deepEqual(result, { status: 'uncertain' }, name);
      const row = (await readSlackIngress(f.db, 'I1'))!;
      assert.equal(row.ack_state, 'uncertain', name);
      assert.equal(row.ack_message_ts, null, name);
      assert.equal(posts, 0, name);
    } finally {
      f.dispose();
    }
  }
});

test('a successful stale response cannot mutate a competing lease, which later repairs', async () => {
  const { f, lease } = await fixture();
  try {
    await updateLeasedIngress(f.db, lease, 'ack_state=\'intent\',ack_json=?', [frozenAckJson()], 100);
    let posts = 0;
    let started = false;
    let release!: () => void;
    const networkGate = new Promise<void>(resolve => { release = resolve; });

    const pending = withFetch(async (url) => {
      if (isPost(url)) {
        posts++;
        started = true;
        await networkGate;
        return Response.json({ ok: true, ts: 'stale.0' });
      }
      return historyResponse();
    }, () => ensureIngressAck(f.db, lease, input(), 100));

    for (let i = 0; i < 20 && !started; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(started);
    f.sql.prepare("UPDATE slack_ingress SET revision=revision+1,lease_owner='B',updated_at=? WHERE id='I1'").run(101);
    release();
    assert.deepEqual(await pending, { status: 'uncertain' });

    const raced = (await readSlackIngress(f.db, 'I1'))!;
    assert.equal(raced.lease_owner, 'B');
    assert.equal(raced.ack_state, 'sending');
    assert.equal(raced.ack_message_ts, null);

    const fresh: IngressLease = { ...lease, owner: 'B', revision: lease.revision + 1 };
    const repaired = await withFetch(async (url) => {
      if (isPost(url)) throw new Error('repair must use metadata only');
      return historyResponse();
    }, () => ensureIngressAck(f.db, fresh, input(), 102));
    assert.deepEqual(repaired, { status: 'posted', ts: '101.0' });
    assert.equal(posts, 1);
  } finally {
    f.dispose();
  }
});

test('a post completing after the one-second wall clock stays uncertain and repairs by metadata', async () => {
  const { f, lease } = await fixture();
  try {
    let posts = 0;
    const latePostSettled = new Promise<void>(resolve => {
      setTimeout(resolve, 1_100);
    });

    const result = await withFetch(async (url) => {
      if (isPost(url)) {
        posts++;
        await latePostSettled;
        return Response.json({ ok: true, ts: 'late.0' });
      }
      return historyResponse();
    }, async () => {
      const uncertain = await ensureIngressAck(f.db, lease, input(), 100);
      assert.deepEqual(uncertain, { status: 'uncertain' });
      await latePostSettled;
      return ensureIngressAck(f.db, lease, input(), 101);
    });

    assert.deepEqual(result, { status: 'posted', ts: '101.0' });
    const row = (await readSlackIngress(f.db, 'I1'))!;
    assert.equal(row.ack_state, 'posted');
    assert.equal(row.ack_message_ts, '101.0');
    assert.equal(posts, 1);
  } finally {
    f.dispose();
  }
});

test('lost committed acknowledgement-save response preserves its confirmed timestamp without another post', async () => {
  const { f, lease } = await fixture();
  let lose = true, posts = 0;
  const db = interceptDb(f.db,(query,_values,result) => {
    if (lose && query.includes("SET ack_state='posted',ack_message_ts=")) {
      lose=false;
      assert.equal(f.sql.prepare('SELECT ack_state FROM slack_ingress').get()!.ack_state,'posted');
      throw new Error('fixture acknowledgement save response lost');
    }
    return result;
  });
  try {
    const result = await withFetch(async url => {
      assert.ok(isPost(url)); posts++; return Response.json({ok:true,ts:'101.0'});
    },()=>ensureIngressAck(db,lease,input(),100));
    assert.deepEqual(result,{status:'posted',ts:'101.0'});
    assert.equal((await readSlackIngress(f.db,'I1'))!.ack_state,'posted');
    assert.equal(posts,1);
    await withFetch(async()=>{throw new Error('confirmed retry must not use HTTP');},async()=>{
      assert.deepEqual(await ensureIngressAck(f.db,lease,input(),101),{status:'posted',ts:'101.0'});
    });
  } finally { f.dispose(); }
});
test('bounded history with a match and unread pages retains uncertain ACK without repost', async () => {
  const { f, lease } = await fixture();
  try {
    await seedAckState(f, lease, 'uncertain');
    let historyCalls = 0, posts = 0;
    await withFetch(async url => {
      if (isPost(url)) { posts++; throw new Error('uncertain ACK must not repost'); }
      return Response.json(++historyCalls === 1
        ? { ok: true, messages: [metadataMessage()], response_metadata: { next_cursor: 'page2' } }
        : { ok: true, messages: [], response_metadata: { next_cursor: 'unread-duplicate-page' } });
    }, async () => {
      assert.deepEqual(await ensureIngressAck(f.db, lease, input(), 100), { status: 'uncertain' });
    });
    assert.equal(historyCalls, 2); assert.equal(posts, 0);
    const row = (await readSlackIngress(f.db, 'I1'))!;
    assert.equal(row.ack_state, 'uncertain'); assert.equal(row.ack_message_ts, null);
    assert.equal(f.count('cutover_producers'), 1);
  } finally { f.dispose(); }
});
await run();
