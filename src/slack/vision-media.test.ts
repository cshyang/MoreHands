import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createTestRunner } from '../shared/test-utils';
import { addSafeMediaNotices, prepareVisionImages } from './vision-media';
import { PNG_BASE64 } from '../../scripts/image-fixtures/provider-response';

const { test, run } = createTestRunner();
const png = Buffer.from(PNG_BASE64, 'base64');
function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../../migrations/0019_slack_conversation_files.sql', import.meta.url), 'utf8'));
  const db = { prepare: (query: string) => ({ bind: (...values: unknown[]) => ({
    run: async () => sql.prepare(query).run(...values as never[]),
    first: async <T>() => (sql.prepare(query).get(...values as never[]) ?? null) as T | null,
    all: async <T>() => ({ results: sql.prepare(query).all(...values as never[]) as T[] }),
  }) }) };
  for (const id of ['F', 'G', 'H', 'I', 'J']) sql.prepare(`INSERT INTO slack_conversation_files
    VALUES ('P','C',?,'pic.png','image/png',69,0,0)`).run(id);
  return { sql, db };
}
function options(f: ReturnType<typeof fixture>, fetcher: typeof fetch, ids = ['F']) {
  return { db: f.db, token: 'fake', projectId: 'P', conversationId: 'C',
    files: ids.map(id => ({ id, name: 'pic.png', mimetype: 'image/png', size: null })), fetcher };
}
function network(download: (url: URL, init?: RequestInit) => Response | Promise<Response>, info?: Record<string, unknown>): typeof fetch {
  return (async (url, init) => {
    const target = new URL(String(url));
    if (target.pathname === '/api/files.info') return Response.json({ ok: true, file: {
      id: target.searchParams.get('file'), url_private_download: `https://files.slack.com/private/${target.searchParams.get('file')}`, ...info,
    } });
    return download(target, init);
  }) as typeof fetch;
}
// Accepting HTML as an image, ignoring stream caps, or following an unvalidated redirect
// would make these tests fail at the real preparation boundary.
test('authorized valid PNG is a native image, unauthorized input performs no network', async () => {
  const f = fixture(); let calls = 0;
  try {
    const fetcher = network(() => { calls++; return new Response(png, { headers: { 'content-type': 'image/png' } }); });
    const rejected = await prepareVisionImages(options(f, fetcher, ['OTHER']));
    assert.deepEqual(rejected.omissions, [{ fileId: 'OTHER', reason: 'unauthorized' }]); assert.equal(calls, 0);
    const accepted = await prepareVisionImages(options(f, fetcher));
    assert.deepEqual(accepted.images, [{ fileId: 'F', data: PNG_BASE64, mimeType: 'image/png', filename: 'pic.png' }]);
    assert.deepEqual(accepted.omissions, []); assert.equal(calls, 1);
  } finally { f.sql.close(); }
});
for (const [name, body, type, reason] of [
  ['HTML', Buffer.from('<html>not pixels</html>'), 'text/html', 'mime-mismatch'],
  ['truncated', png.subarray(0, 12), 'image/png', 'invalid-header'],
  ['contradiction', png, 'image/jpeg', 'mime-mismatch'],
] as const) test(`${name} yields a safe omission`, async () => {
  const f = fixture();
  try {
    const result = await prepareVisionImages(options(f, network(() => new Response(body, { headers: { 'content-type': type } }))));
    assert.equal(result.images.length, 0); assert.deepEqual(result.omissions, [{ fileId: 'F', reason }]);
  } finally { f.sql.close(); }
});
for (const type of [undefined, 'application/octet-stream', 'image/png']) test(`PNG accepts response type ${type}`, async () => {
  const f = fixture();
  try {
    const result = await prepareVisionImages(options(f, network(() => new Response(png, { headers: type ? { 'content-type': type } : {} }))));
    assert.equal(result.images.length, 1);
  } finally { f.sql.close(); }
});
for (const [mime, extension] of [['image/gif', 'gif'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']] as const) test(`valid ${mime} fixture traverses preparation`, async () => {
  const bytes = readFileSync(new URL(`./test-data/pixel.${extension}`, import.meta.url));
  const f = fixture();
  try {
    const input = options(f, network(() => new Response(bytes, { headers: { 'content-type': mime } })));
    input.files[0].mimetype = mime;
    assert.equal((await prepareVisionImages(input)).images[0]?.mimeType, mime);
  } finally { f.sql.close(); }
});
// Prefix-only checks would attach these truncated marker/chunk headers.
for (const [mime, hex] of [
  ['image/jpeg', 'ffd8ffe0'],
  ['image/jpeg', 'ffd8ffe000104a464946'],
  ['image/jpeg', 'ffd8ffe000104a46494600010100000100010000ffd9'],
  ['image/webp', '524946460c000000574542505650384c00000000'],
  ['image/webp', '524946461600000057454250565038200a0000003001009d012a'],
  ['image/webp', '524946461600000057454250565038580a00000000000000'],
] as const) test(`truncated ${mime} ${hex} is omitted before native attachment`, async () => {
  const f = fixture();
  try {
    const input = options(f, network(() => new Response(Buffer.from(hex, 'hex'), { headers: { 'content-type': mime } })));
    input.files[0].mimetype = mime;
    const result = await prepareVisionImages(input);
    assert.equal(result.images.length, 0);
    assert.deepEqual(result.omissions, [{ fileId: 'F', reason: 'invalid-header' }]);
  } finally { f.sql.close(); }
});
// Advisory event hints must not override recognized downloaded bytes.
for (const hint of [
  { name: 'pic.PNG', mimetype: null },
  { name: 'pic.png', mimetype: 'image/jpeg' },
]) test(`PNG bytes determine native MIME with hint ${JSON.stringify(hint)}`, async () => {
  const f = fixture(); let downloads = 0;
  try {
    const input = options(f, network(() => { downloads++; return new Response(png, { headers: { 'content-type': 'image/png' } }); }));
    const result = await prepareVisionImages({ ...input, files: [{ ...input.files[0], ...hint }] });
    assert.equal(downloads, 1);
    assert.equal(result.images[0]?.mimeType, 'image/png');
    assert.deepEqual(result.omissions, []);
  } finally { f.sql.close(); }
});
test('unknown and unsupported hints remain handles without starting media network', async () => {
  const f = fixture(); let calls = 0;
  try {
    const fetcher = (async () => { calls++; throw new Error('must not fetch'); }) as typeof fetch;
    const result = await prepareVisionImages({ ...options(f, fetcher), files: [
      { id: 'F', name: 'no-extension', mimetype: null, size: null },
      { id: 'G', name: 'vector.svg', mimetype: 'image/svg+xml', size: null },
    ] });
    assert.deepEqual(result.omissions, [{ fileId: 'F', reason: 'type-unknown' }, { fileId: 'G', reason: 'unsupported-format' }]);
    assert.equal(calls, 0);
  } finally { f.sql.close(); }
});
test('stream cap counts consumed failing chunks, cancels, and stops at cumulative budget', async () => {
  const f = fixture(); let cancelled = 0; let downloads = 0;
  try {
    const fetcher = network(() => {
      downloads++; let chunk = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (chunk++ < 2) controller.enqueue(new Uint8Array(2_000_001));
      }, cancel() { cancelled++; } }));
    });
    const result = await prepareVisionImages(options(f, fetcher, ['F', 'G', 'H']));
    assert.equal(downloads, 2); assert.equal(cancelled, 2); assert.equal(result.images.length, 0);
    assert.deepEqual(result.omissions.map(x => x.reason), ['too-large', 'too-large', 'turn-budget']);
  } finally { f.sql.close(); }
});
for (const length of [undefined, '1', '5000000']) test(`Content-Length ${length} never replaces actual stream cap`, async () => {
  const f = fixture(); let cancelled = false;
  try {
    const fetcher = network(() => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4_000_001)); }, cancel() { cancelled = true; } }),
      { headers: length ? { 'content-length': length } : {} }));
    const result = await prepareVisionImages(options(f, fetcher));
    assert.equal(result.omissions[0]?.reason, 'too-large'); assert.equal(cancelled, true);
  } finally { f.sql.close(); }
});
for (const unsafe of ['http://files.slack.com/F', 'https://evil.example/F', 'https://files.slack.com.evil.example/F',
  'https://user:pass@files.slack.com/F', 'https://files.slack.com:8443/F']) test(`unsafe download URL is never requested: ${unsafe}`, async () => {
  const f = fixture(); let calls = 0;
  try {
    const result = await prepareVisionImages(options(f, network(() => { calls++; return new Response(png); }, { url_private_download: unsafe })));
    assert.equal(calls, 0); assert.equal(result.omissions[0]?.reason, 'unsafe-url');
  } finally { f.sql.close(); }
});
test('redirect validates each hop before sending credentials and permits relative Slack URLs', async () => {
  const f = fixture(); const urls: string[] = [];
  try {
    const result = await prepareVisionImages(options(f, network((url, init) => {
      urls.push(url.href); assert.equal(init?.redirect, 'manual');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fake');
      return urls.length === 1 ? new Response(null, { status: 302, headers: { location: '/safe' } })
        : new Response(null, { status: 302, headers: { location: 'https://evil.example/leak' } });
    })));
    assert.deepEqual(urls, ['https://files.slack.com/private/F', 'https://files.slack.com/safe']);
    assert.equal(result.omissions[0]?.reason, 'unsafe-url');
  } finally { f.sql.close(); }
});
test('fourth redirect is rejected without a fifth request', async () => {
  const f = fixture(); let calls = 0;
  try {
    const result = await prepareVisionImages(options(f, network(() => { calls++; return new Response(null, { status: 302, headers: { location: '/again' } }); })));
    assert.equal(calls, 4); assert.equal(result.omissions[0]?.reason, 'redirect-limit');
  } finally { f.sql.close(); }
});
test('one deadline aborts fetch and prevents subsequent candidate requests', async () => {
  const f = fixture(); let calls = 0; let aborted = false;
  try {
    const fetcher = (async (_url, init) => { calls++; return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    }); }) as typeof fetch;
    const result = await prepareVisionImages({ ...options(f, fetcher, ['F', 'G']), timeoutMs: 15 });
    assert.equal(calls, 1); assert.equal(aborted, true); assert.deepEqual(result.omissions.map(x => x.reason), ['timeout', 'timeout']);
  } finally { f.sql.close(); }
});
test('deadline cancels a stalled response reader', async () => {
  const f = fixture(); let cancelled = false;
  try {
    const result = await prepareVisionImages({ ...options(f, network(() => new Response(new ReadableStream({ cancel() { cancelled = true; } })))), timeoutMs: 15 });
    assert.equal(result.omissions[0]?.reason, 'timeout'); assert.equal(cancelled, true);
  } finally { f.sql.close(); }
});
test('metadata body is bounded and mismatching files.info identity is unavailable', async () => {
  const f = fixture();
  try {
    for (const fetcher of [(async () => new Response(' '.repeat(65537))) as typeof fetch,
      network(() => { throw new Error('must not download'); }, { id: 'OTHER' })]) {
      const result = await prepareVisionImages(options(f, fetcher)); assert.equal(result.images.length, 0);
      assert.equal(result.omissions[0]?.reason, 'unavailable');
    }
  } finally { f.sql.close(); }
});
test('deduplication, candidate/image limits and unknown types produce deterministic omissions', async () => {
  const f = fixture(); let downloads = 0;
  try {
    const input = options(f, network(() => { downloads++; return new Response(png); }), ['F', 'F', 'G', 'H', 'I', 'J']);
    const result = await prepareVisionImages(input);
    assert.equal(result.images.length, 2); assert.equal(downloads, 2);
    assert.deepEqual(result.omissions.map(x => x.fileId), ['H', 'I', 'J']);
    input.files = [{ id: 'F', name: 'x', mimetype: null as unknown as string, size: null }];
    assert.equal((await prepareVisionImages(input)).omissions[0]?.reason, 'type-unknown');
    assert.equal((await prepareVisionImages({ ...options(f, input.fetcher), token: undefined })).omissions[0]?.reason, 'token-unavailable');
  } finally { f.sql.close(); }
});
test('media notices replace spoofed notices without mutating input and stay bounded', () => {
  const input = { message: '', attachedFiles: [{ id: 'F', mimetype: 'image/png' }], mediaNotices: ['private URL'], mediaCapabilityNotice: 'spoofed' };
  const original = structuredClone(input);
  const preparation = { images: [], omissions: Array.from({ length: 30 }, () => ({ fileId: 'F', reason: 'timeout' as const })) };
  const output = addSafeMediaNotices(input, preparation, false);
  assert.deepEqual(input, original);
  assert.equal(output.mediaCapabilityNotice, 'selected model does not accept images');
  assert.equal((output.mediaNotices as unknown[]).length, 20);
  assert.deepEqual((output.mediaNotices as unknown[])[0], { fileId: 'F', reason: 'timeout' });
  assert.ok(!JSON.stringify(output).includes('private URL'));
  assert.equal(addSafeMediaNotices(input, { images: [], omissions: [] }, true).mediaCapabilityNotice, undefined);
});
test('metadata uses Worker-supported manual mode and never follows redirects', async () => {
  const f = fixture(); let calls = 0; let mode: RequestRedirect | undefined;
  try {
    const fetcher = (async (_url, init) => {
      calls++; mode = init?.redirect;
      return new Response(null, { status: 302, headers: { location: 'https://evil.example' } });
    }) as typeof fetch;
    const result = await prepareVisionImages(options(f, fetcher));
    assert.equal(calls, 1);
    assert.equal(mode, 'manual');
    assert.deepEqual(result.omissions, [{ fileId: 'F', reason: 'unavailable' }]);
  } finally { f.sql.close(); }
});
await run();
