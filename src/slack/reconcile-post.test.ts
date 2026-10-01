import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { findPostedReply } from './reconcile-post';
import { postMessage } from './post';
const { test, run } = createTestRunner();
test('uncertain post reconciliation follows pagination and matches metadata, not text', async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return Response.json(urls.length === 1
      ? { ok: true, messages: [{ ts: 'wrong', text: 'same answer' }], response_metadata: { next_cursor: 'next' } }
      : { ok: true, messages: [{ ts: 'right', metadata: { event_type: 'morehands_reply', event_payload: { delivery_id: 'd' } } }] });
  };
  try {
    assert.equal(await findPostedReply('token', 'channel', 'd', 'thread'), 'right');
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
await run();
