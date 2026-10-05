// Slack post wrapper invariants — run: npx tsx src/slack/post.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { editMessage, postMessage, SlackApiError } from './post';

const { test, run } = createTestRunner();

test('postMessage sends formatted text and optional blocks', async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, ts: '123.456' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const blocks = [{ type: 'header', text: { type: 'plain_text', text: 'Done' } }];
    const ts = await postMessage('xoxb-test', 'C1', '**Done**', '111.222', { blocks });

    assert.equal(ts, '123.456');
    assert.deepEqual(calls[0].body, {
      channel: 'C1',
      text: '*Done*',
      thread_ts: '111.222',
      blocks,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('postMessage carries persona identity fields when supplied', async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, ts: '1.2' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    await postMessage('xoxb-test', 'C1', 'hi', undefined, { username: 'Wren', iconEmoji: ':bird:' });
    assert.equal(calls[0].body.username, 'Wren');
    assert.equal(calls[0].body.icon_emoji, ':bird:');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('postMessage retries without identity when chat:write.customize is missing', async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ body });
    const payload = body.username ? { ok: false, error: 'missing_scope' } : { ok: true, ts: '9.9' };
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const ts = await postMessage('xoxb-test', 'C1', 'hi', undefined, { username: 'Wren', iconEmoji: ':bird:' });
    assert.equal(ts, '9.9');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.username, undefined);
    assert.equal(calls[1].body.icon_emoji, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('editMessage sends formatted text and optional blocks', async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: '*Ready*' } }];
    await editMessage('xoxb-test', 'C1', '123.456', '# Ready', { blocks });

    assert.deepEqual(calls[0].body, {
      channel: 'C1',
      ts: '123.456',
      text: '*Ready*',
      blocks,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an observed HTTP 429 is a positive rejection with validated retry delay', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('gateway disappeared', { status: 429, headers: { 'retry-after': '12' } });
  }) as typeof fetch;

  try {
    await assert.rejects(postMessage('xoxb-test', 'C1', 'hi'), (error: unknown) => {
      assert.ok(error instanceof SlackApiError);
      assert.equal(error.code, 'ratelimited');
      assert.equal(error.httpStatus, 429);
      assert.equal(error.retryAfterSeconds, 12);
      return true;
    });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an invalid or negative Retry-After is omitted but HTTP 429 remains a rejection', async () => {
  const originalFetch = globalThis.fetch;
  const headers = ['-1', 'soon', '1.5'];
  let calls = 0;
  globalThis.fetch = (async () => new Response('', { status: 429, headers: { 'retry-after': headers[calls++] } })) as typeof fetch;

  try {
    while (calls < headers.length) {
      await assert.rejects(postMessage('xoxb-test', 'C1', 'hi'), (error: unknown) => {
        assert.ok(error instanceof SlackApiError);
        assert.equal(error.httpStatus, 429);
        assert.equal(error.retryAfterSeconds, undefined);
        return true;
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a documented JSON rate-limit rejection carries HTTP metadata', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': '7' },
  })) as typeof fetch;

  try {
    await assert.rejects(postMessage('xoxb-test', 'C1', 'hi'), (error: unknown) => {
      assert.ok(error instanceof SlackApiError);
      assert.equal(error.code, 'rate_limited');
      assert.equal(error.httpStatus, 429);
      assert.equal(error.retryAfterSeconds, 7);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('lost transport, 5xx, and malformed responses remain ambiguous errors', async () => {
  const originalFetch = globalThis.fetch;
  const responses: Array<() => Promise<Response>> = [
    async () => { throw new Error('connection lost'); },
    async () => new Response(JSON.stringify({ ok: false, error: 'internal_error' }), { status: 503 }),
    async () => new Response('<html>proxy</html>', { status: 200 }),
  ];
  let calls = 0;
  globalThis.fetch = (async () => responses[calls++]()) as typeof fetch;

  try {
    for (let i = 0; i < responses.length; i++) {
      await assert.rejects(postMessage('xoxb-test', 'C1', 'hi'), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof SlackApiError));
        return true;
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the missing-scope fallback keeps durable delivery metadata', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push(body);
    return new Response(JSON.stringify(body.username ? { ok: false, error: 'missing_scope' } : { ok: true, ts: '9.9' }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const ts = await postMessage('xoxb-test', 'C1', 'hi', undefined, {
      username: 'Wren',
      deliveryId: 'd',
    });
    assert.equal(ts, '9.9');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].metadata, { event_type: 'morehands_reply', event_payload: { delivery_id: 'd' } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await run();
