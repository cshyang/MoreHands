// Thread backscroll: fetch + render for context hydration — run: npx tsx src/slack/threads.test.ts
import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { renderThreadBackscroll, fetchThreadReplies, fetchChannelHistory, slackMediaContext, type ThreadMessage } from './threads';
import { prepareVisionImages } from './vision-media';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { PNG_BASE64 } from '../../scripts/image-fixtures/provider-response';

const { test, run } = createTestRunner();

const msgs: ThreadMessage[] = [
  { user: 'Ualex', text: 'can we change the pricing?', ts: '1.0' },
  { bot_id: 'B1', user: 'Ubot', text: 'I looked into it', ts: '2.0' },
  { user: 'Ujo', text: 'what did you find?', ts: '3.0' },
];

test('renderThreadBackscroll: marks the bot, labels others, oldest→newest', async () => {
  const out = renderThreadBackscroll(msgs, 'Ubot');
  assert.equal(
    out,
    'Ualex: can we change the pricing?\nyou (earlier): I looked into it\nUjo: what did you find?',
  );
});

test('renderThreadBackscroll: excludes the triggering message by ts', async () => {
  const out = renderThreadBackscroll(msgs, 'Ubot', { excludeTs: '3.0' });
  assert.ok(!out.includes('what did you find?'), 'triggering message omitted');
  assert.ok(out.includes('can we change the pricing?'), 'prior context kept');
});

test('renderThreadBackscroll: empty input → empty string', async () => {
  assert.equal(renderThreadBackscroll([], 'Ubot'), '');
});

test('renderThreadBackscroll: caps to maxChars, dropping oldest first', async () => {
  const out = renderThreadBackscroll(msgs, 'Ubot', { maxChars: 30 });
  assert.ok(out.includes('Ujo: what did you find?'), 'most recent kept');
  assert.ok(!out.includes('pricing'), 'oldest dropped to fit budget');
});

// A fake fetch that records calls and returns a canned Response (mirrors nango.test.ts).
function fakeFetch(responder: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return responder(String(url), (init ?? {}) as RequestInit);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test('fetchThreadReplies: GETs conversations.replies with Bearer, parses messages', async () => {
  const { fn, calls } = fakeFetch(() =>
    new Response(JSON.stringify({ ok: true, messages: [
      { user: 'Ualex', text: 'hi', ts: '1.0' },
      { bot_id: 'B1', user: 'Ubot', text: 'hello', ts: '2.0' },
    ] }), { status: 200 }),
  );
  const out = await fetchThreadReplies('xoxb-tok', 'C1', '1.0', { fetchImpl: fn });
  assert.equal(out.length, 2);
  assert.equal(out[0].text, 'hi');
  assert.equal(out[1].bot_id, 'B1');
  assert.match(calls[0].url, /conversations\.replies\?channel=C1&ts=1\.0&limit=200/);
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer xoxb-tok');
});

test('fetchThreadReplies: ok:false → empty array', async () => {
  const { fn } = fakeFetch(() => new Response(JSON.stringify({ ok: false, error: 'thread_not_found' }), { status: 200 }));
  assert.deepEqual(await fetchThreadReplies('t', 'C1', '1.0', { fetchImpl: fn }), []);
});

test('fetchChannelHistory: GETs conversations.history and reverses to chronological order', async () => {
  const { fn, calls } = fakeFetch(() =>
    new Response(JSON.stringify({ ok: true, messages: [
      { user: 'U2', text: 'newest', ts: '2.0' },
      { user: 'U1', text: 'oldest', ts: '1.0' },
    ] }), { status: 200 }),
  );
  const out = await fetchChannelHistory('xoxb-tok', 'C1', { fetchImpl: fn });
  assert.deepEqual(out.map((m) => m.text), ['oldest', 'newest']);
  assert.match(calls[0].url, /conversations\.history\?channel=C1&limit=30/);
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer xoxb-tok');
});

test('fetchChannelHistory: ok:false → empty array; limit clamps to 200', async () => {
  const { fn } = fakeFetch(() => new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 }));
  assert.deepEqual(await fetchChannelHistory('t', 'C1', { fetchImpl: fn }), []);
  const { fn: fn2, calls } = fakeFetch(() => new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }));
  await fetchChannelHistory('t', 'C1', { fetchImpl: fn2, limit: 999 });
  assert.match(calls[0].url, /limit=200/);
});

test('image-only prior message renders timestamped safe file handles', () => {
  const rendered = renderThreadBackscroll([{ user: 'U', text: '', ts: '1.0', files: [{ id: 'F', name: 'pic.png', mimetype: 'image/png', size: null }] }], 'BOT');
  for (const part of ['U', '1.0', 'F', 'pic.png']) assert.ok(rendered.includes(part));
});
for (const channel of [false, true]) test(`${channel ? 'channel' : 'thread'} history strips private file URLs`, async () => {
  const { fn } = fakeFetch(() => Response.json({ ok: true, messages: [{ user: 'U', ts: '1', files: [{ id: 'F', name: 'pic.png', url_private: 'https://private' }] }] }));
  const messages = channel ? await fetchChannelHistory('t', 'C', { fetchImpl: fn }) : await fetchThreadReplies('t', 'C', '1', { fetchImpl: fn });
  assert.deepEqual(messages[0].files, [{ id: 'F', name: 'pic.png', mimetype: null, size: null }]);
  assert.ok(!JSON.stringify(messages).includes('url_private'));
});
test('media context bounds history and prefers current files with stable deduplication', () => {
  const file = (id: string) => ({ id, name: `${id}.png`, mimetype: 'image/png', size: null });
  const history = Array.from({ length: 30 }, (_, n) => ({ user: 'U', text: '', ts: String(n), files: [file(`H${n}`)] }));
  const media = slackMediaContext([file('CURRENT'), file('H28')], history, '29');
  assert.equal(media.historyFiles.length, 20);
  assert.equal(media.historyFiles[0].id, 'H9');
  assert.deepEqual(media.imageCandidates.slice(0, 4).map(f => f.id), ['CURRENT', 'H28', 'H27', 'H26']);
  assert.ok(!JSON.stringify(media).includes('H29'));
  const many = slackMediaContext([], [{ text: '', ts: '1', files: Array.from({ length: 40 }, (_, n) => file(`F${n}`)) }], '2');
  assert.equal(many.historyFiles.length, 20);
});
test('history pixels and rendered handles use the same latest twenty references', () => {
  const files = Array.from({ length: 40 }, (_, n) => ({ id: `F${n}`, name: null, mimetype: 'image/png', size: null }));
  const history = [{ user: 'U', text: '', ts: '1', files }];
  const media = slackMediaContext([], history, '2');
  assert.deepEqual(media.imageCandidates.slice(0, 4).map(file => file.id), ['F39', 'F38', 'F37', 'F36']);
  assert.equal(media.imageCandidates.length, 20);
  const rendered = renderThreadBackscroll(history, 'BOT');
  assert.ok(rendered.includes('[file F39:'));
  assert.ok(!rendered.includes('[file F0:'));
  assert.equal((rendered.match(/\[file /g) ?? []).length, 20);
});
// Slicing producer candidates before preparation would hide fifth+ omissions.
for (const valid of [true, false]) test(`all six handles receive pixels or omissions with ${valid ? 'valid' : 'failed'} downloads`, async () => {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../../migrations/0019_slack_conversation_files.sql', import.meta.url), 'utf8'));
  const db = { prepare: (query: string) => ({ bind: (...values: unknown[]) => ({
    first: async <T>() => (sql.prepare(query).get(...values as never[]) ?? null) as T | null,
    run: async () => sql.prepare(query).run(...values as never[]),
    all: async <T>() => ({ results: sql.prepare(query).all(...values as never[]) as T[] }),
  }) }) };
  const files = Array.from({ length: 6 }, (_, n) => ({ id: `F${n}`, name: 'pic.png', mimetype: 'image/png', size: null }));
  let downloads = 0;
  try {
    for (const file of files) sql.prepare("INSERT INTO slack_conversation_files VALUES('P','C',?,'pic.png','image/png',69,0,0)").run(file.id);
    const fetcher = (async (url) => String(url).startsWith('https://slack.com/api/files.info')
      ? Response.json({ ok: true, file: { id: new URL(String(url)).searchParams.get('file'), url_private_download: 'https://files.slack.com/F' } })
      : (++downloads, new Response(valid ? Buffer.from(PNG_BASE64, 'base64') : Buffer.from('broken')))) as typeof fetch;
    const media = slackMediaContext(files, [], '1');
    const result = await prepareVisionImages({ db, token: 'fake', projectId: 'P', conversationId: 'C', files: media.imageCandidates, fetcher });
    assert.deepEqual(media.currentFiles.map(file => file.id), ['F0', 'F1', 'F2', 'F3', 'F4', 'F5']);
    assert.equal(downloads, valid ? 2 : 4);
    assert.deepEqual(result.omissions, valid
      ? ['F2', 'F3', 'F4', 'F5'].map(fileId => ({ fileId, reason: 'image-limit' }))
      : [...['F0', 'F1', 'F2', 'F3'].map(fileId => ({ fileId, reason: 'invalid-header' })),
        ...['F4', 'F5'].map(fileId => ({ fileId, reason: 'image-limit' }))]);
  } finally { sql.close(); }
});
await run();
