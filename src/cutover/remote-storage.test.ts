import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { ingressDbFixture } from '../slack/test-utils/ingress-db';
import { createTestRunner } from '../shared/test-utils';
import remoteProbe, { type RemoteProbeEnv, validateProbeIdentity } from '../../scripts/ingress-fixtures/remote-storage-entry';
import { frozenRequestBytes, probeEventRaw, probeTextRequest, utf8PaddedRequest } from '../../scripts/ingress-fixtures/storage-payload';

const { test, run } = createTestRunner();
const probeId = '123456789abcdef0';
const token = 'f'.repeat(64); // Test-only placeholder, never a real credential.
const identity = { PROBE_ID: probeId, PROBE_DATABASE_ID: '11111111-1111-4111-8111-111111111111', PROBE_DATABASE_NAME: `morehands-cutover-db-${probeId}` };
function fixture() {
  const f = ingressDbFixture('closed');
  f.sql.exec('CREATE TABLE probe_ownership(id INTEGER PRIMARY KEY,probe_id TEXT,database_id TEXT,database_name TEXT); CREATE TABLE probe_guard_definitions(name TEXT PRIMARY KEY,sql TEXT NOT NULL);');
  f.sql.prepare('INSERT INTO probe_ownership VALUES(1,?,?,?)').run(probeId, identity.PROBE_DATABASE_ID, identity.PROBE_DATABASE_NAME);
  f.sql.exec("INSERT INTO probe_guard_definitions SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'slack_ingress_%'");
  const env: RemoteProbeEnv = { ...identity, PROBE_TOKEN: token, DB: f.db as unknown as D1Database };
  const post = (path: string, body: unknown, overrides: Partial<RemoteProbeEnv> = {}, extraHeaders: Record<string, string> = {}) => remoteProbe.fetch(new Request('https://probe' + path,
    { method: 'POST', headers: { 'x-probe-token': token, 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) }), { ...env, ...overrides });
  return { ...f, env, post };
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('remote probe rejects production identity and unauthorized calls before binding access', async () => {
  assert.equal(validateProbeIdentity({ ...identity, PROBE_DATABASE_ID: '6ac5de79-a8c0-4e08-aab8-b9b636278a9d' }), false);
  assert.equal(validateProbeIdentity({ ...identity, PROBE_DATABASE_NAME: 'hatchery-skills' }), false);
  const db = { prepare() { throw new Error('must not access binding'); } } as unknown as D1Database;
  const env = { ...identity, PROBE_TOKEN: token, DB: db };
  assert.equal((await remoteProbe.fetch(new Request('https://probe/probe/health'), env)).status, 404);
  const request = new Request('https://probe/probe/health', { headers: { 'x-probe-token': token } });
  assert.equal((await remoteProbe.fetch(request, { ...env, PROBE_DATABASE_ID: '6ac5de79-a8c0-4e08-aab8-b9b636278a9d' })).status, 503);
});

test('unknown actual binding ownership prevents control mutation', async () => {
  const f = fixture();
  try {
    f.sql.prepare('UPDATE probe_ownership SET probe_id=?').run('other');
    assert.equal((await f.post('/probe/control', { state: 'open' })).status, 503);
    assert.equal(f.sql.prepare('SELECT state FROM cutover_control').get()!.state, 'closed');
  } finally { f.sql.close(); }
});

test('signed probe acceptance commits one event and producer across duplicate responses', async () => {
  const f = fixture();
  try {
    await f.post('/probe/control', { state: 'open' });
    const raw = probeEventRaw(`${probeId}-A1`, 'synthetic only', '1.0');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = { 'x-probe-token': token, 'x-slack-request-timestamp': timestamp,
      'x-slack-signature': 'v0=' + createHmac('sha256', token).update(`v0:${timestamp}:${raw}`).digest('hex') };
    const lost = await remoteProbe.fetch(new Request('https://probe/probe/accept', { method: 'POST', body: raw,
      headers: { ...headers, 'x-probe-drop-accept-response': '1' } }), f.env);
    assert.equal(lost.status, 503);
    for (const duplicate of [true, true]) {
      const response = await remoteProbe.fetch(new Request('https://probe/probe/accept', { method: 'POST', body: raw, headers }), f.env);
      assert.equal(response.status, 200);
      assert.ok(Number(response.headers.get('x-probe-query-total')) <= 50);
      assert.equal((await response.json() as { duplicate: boolean }).duplicate, duplicate);
    }
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM slack_ingress').get()!.n, 1);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM cutover_producers').get()!.n, 1);
  } finally { f.sql.close(); }
});

test('published near-limit request resumes unchanged and cleanup response loss is idempotent', async () => {
  const f = fixture();
  try {
    const eventId = `${probeId}-LARGE`;
    const requestDigest = digest(frozenRequestBytes(utf8PaddedRequest()));
    const body = { eventId, utf8: true, requestDigest };
    const first = await f.post('/probe/store', body, {}, { 'x-probe-drop-store-response': '1' });
    assert.equal(first.status, 503);
    assert.ok(Number(first.headers.get('x-probe-query-total')) <= 50);
    const resumed = await f.post('/probe/store', body);
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json() as { resumed: boolean }).resumed, true);
    assert.equal((await f.post('/probe/store', { ...body, requestDigest: '0'.repeat(64) })).status, 409);
    const loaded = await f.post('/probe/load', { eventId, ingressId: `storage-proof:${eventId}`, utf8: true });
    assert.equal((await loaded.json() as { digest: string }).digest, requestDigest);
    const lostCleanup = await f.post('/probe/cleanup', { probeId, savedEvidenceSha256: 'a'.repeat(64) }, {},
      { 'x-probe-drop-cleanup-response': '1' });
    assert.equal(lostCleanup.status, 503);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM slack_ingress').get()!.n, 0);
    for (let i = 0; i < 2; i++) {
      const response = await f.post('/probe/cleanup', { probeId, savedEvidenceSha256: 'a'.repeat(64) });
      assert.equal(response.status, 200);
      assert.ok(Number(response.headers.get('x-probe-query-total')) <= 50);
      assert.deepEqual((await response.json() as { counts: unknown }).counts, { events: 0, producers: 0, chunks: 0, manifests: 0 });
    }
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'slack_ingress_%'").get()!.n,
      f.sql.prepare('SELECT COUNT(*) AS n FROM probe_guard_definitions').get()!.n);
  } finally { f.sql.close(); }
});

test('cleanup keeps foreign rows and restores guards after deliberate fault injection', async () => {
  const f = fixture();
  try {
    const eventId = `${probeId}-FAULT`;
    await f.post('/probe/store', { eventId, utf8: false, requestDigest: digest(frozenRequestBytes(probeTextRequest(eventId))) });
    const fault = await f.post('/probe/fault', { ingressId: `storage-proof:${eventId}`, mode: 'missing-chunk' });
    assert.equal((await fault.json() as { failedClosed: boolean }).failedClosed, true);
    f.sql.prepare('INSERT INTO slack_ingress(id,team_id,event_id,digest,event_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('foreign', 'T', 'foreign', 'a'.repeat(64), '{}', 1, 1);
    assert.equal((await f.post('/probe/cleanup', { probeId, savedEvidenceSha256: 'a'.repeat(64) })).status, 409);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM slack_ingress').get()!.n, 2);
    f.sql.prepare('DELETE FROM slack_ingress WHERE id=?').run('foreign');
    f.sql.prepare('DELETE FROM cutover_producers WHERE id=?').run('foreign');
    assert.equal((await f.post('/probe/cleanup', { probeId, savedEvidenceSha256: 'a'.repeat(64) })).status, 200);
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'slack_ingress_%'").get()!.n,
      f.sql.prepare('SELECT COUNT(*) AS n FROM probe_guard_definitions').get()!.n);
  } finally { f.sql.close(); }
});

test('reconstructed corruption trials stay failed closed without replacing their original rows', async () => {
  const f = fixture();
  try {
    for (const [i, mode] of ['missing-chunk', 'corrupt-chunk', 'corrupt-manifest-digest'].entries()) {
      const eventId = `${probeId}-F${i}`;
      await f.post('/probe/store', { eventId, utf8: false, requestDigest: digest(frozenRequestBytes(probeTextRequest(eventId))) });
      for (let attempt = 0; attempt < 2; attempt++) {
        // A reconstructed driver inspects an existing trial rather than storing again.
        const row = (await (await f.post('/probe/inspect', { eventId })).json() as { row: { producer_rows: number } }).row;
        assert.equal(row.producer_rows, 1);
        const result = await (await f.post('/probe/fault', { ingressId: `storage-proof:${eventId}`, mode })).json() as {
          failedClosed: boolean; retained: { producer_rows: number };
        };
        assert.equal(result.failedClosed, true);
        assert.equal(result.retained.producer_rows, 1);
      }
    }
    assert.equal(f.count('slack_ingress'), 3);
  } finally { f.sql.close(); }
});

test('scope rejections retain query evidence and health proves the cleanup budget before writes', async () => {
  const f = fixture();
  try {
    const health = await remoteProbe.fetch(new Request('https://probe/probe/health', { headers: { 'x-probe-token': token } }), f.env);
    const data = await health.json() as { guardCount: number; cleanupStatements: number };
    assert.ok(data.guardCount > 0 && data.cleanupStatements <= 50);
    const rejected = await f.post('/probe/store', { eventId: 'outside' });
    assert.equal(rejected.status, 400);
    assert.equal(Number(rejected.headers.get('x-probe-query-total')), 1);
    assert.equal(f.count('slack_ingress'), 0);
  } finally { f.sql.close(); }
});

await run();
