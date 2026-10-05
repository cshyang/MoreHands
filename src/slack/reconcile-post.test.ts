import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestRunner } from '../shared/test-utils';
import { findPostedReply } from './reconcile-post';
import { postMessage, SlackApiError } from './post';
const { test, run } = createTestRunner();
test('uncertain post reconciliation follows pagination and matches metadata, not text', async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return Response.json(urls.length === 1
      ? { ok: true, messages: [{ ts: 'wrong', text: 'same answer' }], response_metadata: { next_cursor: 'next' } }
      : { ok: true, messages: [{ ts: '200.0', metadata: { event_type: 'morehands_reply', event_payload: { delivery_id: 'd' } } }] });
  };
  try {
    assert.equal(await findPostedReply('token', 'channel', 'd', '100.0'), '200.0');
    assert.ok(urls[1].includes('cursor=next')); assert.ok(urls[0].includes('include_all_metadata=true'));
  } finally { globalThis.fetch = original; }
});
test('unavailable history fails instead of authorizing a fresh post', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ok: false, error: 'missing_scope' });
  try { await assert.rejects(findPostedReply('token', 'channel', 'd'), /missing_scope/); }
  finally { globalThis.fetch = original; }
});
test('fresh replies carry durable metadata', async () => {
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json({ ok: true, ts: 'posted' }); };
  try {
    await postMessage('token', 'channel', 'answer', 'thread', { deliveryId: 'd' });
    assert.deepEqual(body.metadata, { event_type: 'morehands_reply', event_payload: { delivery_id: 'd' } });
  } finally { globalThis.fetch = original; }
});
test('installed-manifest patch registers the real outbound metadata without unrelated changes', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../../slack-app.manifest.json', import.meta.url), 'utf8'));
  const before = JSON.parse(readFileSync(new URL('./test-data/manifest-before-cutover.json', import.meta.url), 'utf8'));
  const original = globalThis.fetch;
  let body: any;
  globalThis.fetch = async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json({ ok: true, ts: 'posted' }); };
  try {
    await postMessage('test-token', 'test-channel', 'answer', '100.0', { deliveryId: 'd' });
    assert.equal(body.metadata.event_type, 'morehands_reply');
    assert.equal(body.metadata.event_payload.delivery_id, 'd');
    assert.equal((manifest.metadata?.event_subscriptions ?? []).filter((r: any) => r.event_type === body.metadata.event_type).length, 1);
    globalThis.fetch = async () => Response.json({ ok: true, messages: [{ ts: '200.0', metadata: body.metadata }] });
    assert.equal(await findPostedReply('test-token', 'test-channel', 'd', '100.0'), '200.0');
    delete manifest.metadata; assert.deepEqual(manifest, before);
  } finally { globalThis.fetch = original; }
});
for (const [name, metadata] of [
  ['wrong event type', { event_type: 'other', event_payload: { delivery_id: 'd' } }],
  ['wrong delivery ID', { event_type: 'morehands_reply', event_payload: { delivery_id: 'other' } }],
  ['absent metadata', undefined],
] as const) test(`${name} cannot confirm uncertain delivery`, async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ok: true, messages: [{ ts: 'not-proof', metadata }] });
  try { assert.equal(await findPostedReply('test-token', 'test-channel', 'd', '100.0'), null); }
  finally { globalThis.fetch = original; }
});

const replyMetadata = (deliveryId = 'd') => ({
  event_type: 'morehands_reply',
  event_payload: { delivery_id: deliveryId },
});

test('durable lookup requests two bounded pages with an inclusive time range', async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return Response.json(urls.length === 1
      ? { ok: true, messages: [], response_metadata: { next_cursor: 'page2' } }
  : { ok: true, messages: [{ ts: '200.0', subtype: 'bot_message', user: 'U1', app_id: 'A1', metadata: replyMetadata() }] });
  };
  try {
    assert.equal(await findPostedReply('token', 'channel', 'd', '100.0', {
      maxPages: 2, pageSize: 100, oldestTs: '100.0', botId: 'U1', appId: 'A1',
    }), '200.0');
    assert.equal(urls.length, 2);
    for (const url of urls) {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('limit'), '100');
      assert.equal(parsed.searchParams.get('oldest'), '100.0');
      assert.equal(parsed.searchParams.get('inclusive'), 'true');
      assert.equal(parsed.searchParams.get('ts'), '100.0');
    }
    assert.ok(new URL(urls[1]).searchParams.get('cursor')?.includes('page2'));
  } finally { globalThis.fetch = original; }
});

test('the inclusive oldest bound accepts an equal timestamp and rejects older metadata', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    ok: true,
    messages: [{ ts: '99.999', subtype: 'bot_message', user: 'U1', app_id: 'A1', metadata: replyMetadata() }],
  });
  try {
    assert.equal(await findPostedReply('token', 'channel', 'd', undefined, {
      maxPages: 2, oldestTs: '100.0', botId: 'U1', appId: 'A1',
    }), null);
    globalThis.fetch = async () => Response.json({
      ok: true,
      messages: [{ ts: '100.0', subtype: 'bot_message', user: 'U1', app_id: 'A1', metadata: replyMetadata() }],
    });
    assert.equal(await findPostedReply('token', 'channel', 'd', undefined, {
      maxPages: 2, oldestTs: '100.0', botId: 'U1', appId: 'A1',
    }), '100.0');
  } finally { globalThis.fetch = original; }
});

test('persona authorship accepts trusted app identity without bot_id comparison', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    ok: true,
    messages: [{ ts: '200.0', subtype: 'bot_message', bot_id: 'B-other', app_id: 'A1', metadata: replyMetadata() }],
  });
  try {
    assert.equal(await findPostedReply('token', 'channel', 'd', undefined, {
      maxPages: 2, botId: 'U1', appId: 'A1',
    }), '200.0');

    globalThis.fetch = async () => Response.json({
      ok: true,
      messages: [{ ts: '200.0', subtype: 'bot_message', user: 'U2', app_id: 'A1', metadata: replyMetadata() }],
    });
    assert.equal(await findPostedReply('token', 'channel', 'd', undefined, {
      maxPages: 2, botId: 'U1', appId: 'A1',
    }), null);

    globalThis.fetch = async () => Response.json({
      ok: true,
      messages: [{ ts: '200.0', subtype: 'bot_message', bot_id: 'B-any', metadata: replyMetadata() }],
    });
    assert.equal(await findPostedReply('token', 'channel', 'd', undefined, {
      maxPages: 2, botId: 'U1',
    }), null);
  } finally { globalThis.fetch = original; }
});

test('mismatched thread scope cannot repair an uncertain delivery', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    ok: true,
    messages: [{ ts: '200.0', thread_ts: 'other', user: 'U1', app_id: 'A1', metadata: replyMetadata() }],
  });
  try {
    assert.equal(await findPostedReply('token', 'channel', 'd', '100.0', {
      maxPages: 2, botId: 'U1', appId: 'A1',
    }), null);
  } finally { globalThis.fetch = original; }
});

test('mismatched channel scope cannot repair an uncertain delivery', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    ok: true,
    messages: [{ ts: '200.0', channel: 'other', user: 'U1', app_id: 'A1', metadata: replyMetadata() }],
  });
  try {
    assert.equal(await findPostedReply('token', 'channel', 'd', '100.0', {
      maxPages: 2, botId: 'U1', appId: 'A1',
    }), null);
  } finally { globalThis.fetch = original; }
});

test('a user-less persona row requires the trusted app id', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    ok: true,
    messages: [{ ts: '200.0', subtype: 'bot_message', app_id: 'A2', metadata: replyMetadata() }],
  });
  try {
    assert.equal(await findPostedReply('token', 'channel', 'd', undefined, {
      maxPages: 2, botId: 'U1', appId: 'A1',
    }), null);
  } finally { globalThis.fetch = original; }
});

test('duplicate metadata matches stay unconfirmed', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    ok: true,
    messages: [
      { ts: '200.0', subtype: 'bot_message', user: 'U1', app_id: 'A1', metadata: replyMetadata() },
      { ts: '201.0', subtype: 'bot_message', user: 'U1', app_id: 'A1', metadata: replyMetadata() },
    ],
  });
  try {
    assert.equal(await findPostedReply('token', 'channel', 'd', undefined, { maxPages: 2 }), null);
  } finally { globalThis.fetch = original; }
});

test('lookup validates options before making a network request', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ ok: true, messages: [] }); };
  try {
    for (const options of [
      { maxPages: 0 },
      { maxPages: 1.5 },
      { pageSize: 0 },
      { oldestTs: 'not-a-time' },
    ]) {
      await assert.rejects(
        findPostedReply('token', 'channel', 'd', 'bad-time', options),
        /Invalid Slack reconciliation options/,
      );
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('malformed and server-error history responses stay ambiguous', async () => {
  const original = globalThis.fetch;
  const responses = [
    () => new Response('<html/>'),
    () => new Response(JSON.stringify({ ok: true, messages: 'no' })),
    () => new Response(JSON.stringify({ ok: false, error: 'internal_error' }), { status: 500 }),
  ];
  let calls = 0;
  globalThis.fetch = async () => responses[calls++]();
  try {
    for (let i = 0; i < responses.length; i++) {
      await assert.rejects(findPostedReply('token', 'channel', 'd', undefined, { maxPages: 2 }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof SlackApiError));
        return true;
      });
    }
  } finally { globalThis.fetch = original; }
});

test('a repeated history cursor is rejected instead of looping forever', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ok: true, messages: [], response_metadata: { next_cursor: 'same' } });
  try {
    await assert.rejects(
      findPostedReply('token', 'channel', 'd', undefined, { maxPages: 4 }),
      /repeated Slack history cursor/,
    );
  } finally { globalThis.fetch = original; }
});

test('a positive history rate limit exposes safe retry metadata', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 429, headers: { 'retry-after': '3' } });
  try {
    await assert.rejects(findPostedReply('token', 'channel', 'd', undefined, { maxPages: 2 }), (error: unknown) => {
      assert.ok(error instanceof SlackApiError);
      assert.equal(error.httpStatus, 429);
      assert.equal(error.retryAfterSeconds, 3);
      return true;
    });
  } finally { globalThis.fetch = original; }
});
test('a match before the page cap cannot confirm while another cursor remains', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => Response.json(++calls === 1
    ? { ok: true, messages: [{ ts: '200.0', user: 'U1', app_id: 'A1', metadata: replyMetadata() }], response_metadata: { next_cursor: 'page2' } }
    : { ok: true, messages: [], response_metadata: { next_cursor: 'unread-duplicate-page' } });
  try {
    assert.equal(await findPostedReply('token', 'channel', 'd', undefined, {
      maxPages: 2, oldestTs: '100.0', botId: 'U1', appId: 'A1',
    }), null);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});
await run();
