// Local Miniflare D1 ingress storage proof (explicit --local only).
// No model calls, no Slack network, no production target, no credentials.
// Prints metadata-only JSON evidence to stdout; progress goes to stderr.
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { migrationStatements } from './migration-statements';
import {
  NEAR_LIMIT_ENVELOPE_BYTES, frozenRequestBytes, probeEventRaw, probeTextRequest, utf8PaddedRequest,
} from './ingress-fixtures/storage-payload';

const PRODUCTION_DATABASE_NAME = 'hatchery-skills';
const PRODUCTION_DATABASE_ID = '6ac5de79-a8c0-4e08-aab8-b9b636278a9d';
const SIGNING_SECRET = 'local-storage-proof-signing';
const ACCEPT_WINDOW_MS = 3_000;
const QUERY_BUDGET = 50;
const TEMP_PREFIX = 'morehands-d1-storage-proof-';
const INGRESS_TABLES = ['slack_ingress', 'slack_ingress_manifests', 'slack_ingress_chunks', 'cutover_control', 'cutover_producers'];
const INGRESS_TRIGGERS = [
  'slack_ingress_owns_producer', 'slack_ingress_identity_immutable', 'slack_ingress_route_immutable',
  'slack_ingress_terminal_immutable', 'slack_ingress_content_guard', 'slack_ingress_manifest_immutable',
  'slack_ingress_chunk_immutable', 'slack_ingress_chunk_append_guard', 'slack_ingress_chunk_delete_guard',
  'slack_ingress_manifest_delete_guard', 'slack_ingress_publication_guard', 'slack_ingress_completion_guard',
  'slack_ingress_releases_producer',
];

const args = process.argv.slice(2);

function remoteBlocked(): never {
  console.log(JSON.stringify({
    mode: 'remote', status: 'blocked',
    rejectedTargets: [{ name: PRODUCTION_DATABASE_NAME, databaseId: PRODUCTION_DATABASE_ID }],
    reason: 'Remote mode is rejected before any network or mutation. No authorization targets are configured. '
      + 'This is an accepted implementation limitation: a true remote capacity/latency probe is still required later, '
      + 'and remote completeness is not claimed. It requires an explicitly provisioned disposable D1 target and explicit approval. '
      + 'Local success cannot satisfy the production capacity gate.',
  }, null, 2));
  process.exit(2);
}

if (args.includes('--remote')) remoteBlocked();
if (args.length !== 1 || args[0] !== '--local') {
  process.stderr.write('Usage: tsx scripts/d1-ingress-storage-proof.ts --local\n'
    + 'Remote mode is rejected without a target; there is no default target.\n');
  process.exit(2);
}

// Safety target validation before the first mutation of any kind.
const cwd = resolve();
for (const path of ['package.json', 'migrations/0033_slack_ingress.sql', 'scripts/migration-statements.ts',
  'scripts/ingress-fixtures/storage-entry.ts', 'scripts/ingress-fixtures/storage-payload.ts']) {
  assert.ok(existsSync(join(cwd, path)), `safety check: missing ${path}`);
}
const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as { name?: string };
assert.equal(pkg.name, 'morehands');
assert.deepEqual(migrationStatements('CREATE TABLE a(b INTEGER); -- c\nCREATE TABLE d(e TEXT)'), ['CREATE TABLE a(b INTEGER)', 'CREATE TABLE d(e TEXT)']);
assert.match(PRODUCTION_DATABASE_ID, /^[0-9a-f-]{36}$/);
const safety = {
  mode: 'local', repositoryChecked: cwd,
  target: 'isolated in-memory Miniflare D1 binding (probe owned, disposed after proof)',
  productionRejectList: [{ name: PRODUCTION_DATABASE_NAME, databaseId: PRODUCTION_DATABASE_ID }],
  credentialsRead: false, remoteNetwork: false, firstMutationPlanned: 'probe-owned temp bundle directory under os.tmpdir()',
};

function progress(message: string): void {
  process.stderr.write(`[d1-storage-proof] ${message}\n`);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function distribution(values: number[]): { count: number; minMs: number; meanMs: number; p95Ms: number; maxMs: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length, minMs: sorted[0],
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)], maxMs: sorted[sorted.length - 1],
  };
}

// Cleanup policy: a run owns only its own new mkdtemp directory and never scans or deletes
// other probe-prefixed directories. Interrupted runs stay retained; explicit resume by
// probe ID is a possible future feature and intentionally not implemented here.

const require_ = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = require_('miniflare') as {
  Miniflare: new (options: unknown) => MiniflareLike;
  convertV4MiniflareOptions: (options: unknown) => { workers: Array<{ config: { manifest?: unknown } }> };
};
const { build } = require_('esbuild') as { build: (options: Record<string, unknown>) => Promise<unknown> };

interface MiniflareLike {
  getD1Database(binding: string): Promise<D1Database>;
  dispatchFetch(url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<Response>;
  dispose(): Promise<void>;
}

const temporary = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
const scriptPath = join(temporary, 'storage-entry.mjs');
let miniflare: MiniflareLike | null = null;
let cleanupDone = false;

async function cleanup(): Promise<void> {
  if (cleanupDone) return;
  cleanupDone = true;
  try { await miniflare?.dispose(); } catch { /* best effort */ }
  await rm(temporary, { recursive: true, force: true });
}

process.on('SIGINT', () => { void cleanup().finally(() => process.exit(130)); });
process.on('SIGTERM', () => { void cleanup().finally(() => process.exit(143)); });

try {
  progress('bundling minimal probe worker with installed esbuild');
  await build({
    entryPoints: [resolve('scripts/ingress-fixtures/storage-entry.ts')], outfile: scriptPath,
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', legalComments: 'none',
  });
  const artifactSha256 = sha256(new TextEncoder().encode(await readFile(scriptPath, 'utf8')));

  const outboundViolations: string[] = [];
  const options = convertV4MiniflareOptions({
    name: 'morehands-d1-storage-proof', modules: true, scriptPath,
    compatibilityDate: '2026-06-09', d1Databases: ['DB'],
    bindings: { SLACK_SIGNING_SECRET: SIGNING_SECRET, CUTOVER_CONTROL: 'd1' },
    telemetry: { enabled: false },
    outboundService: async (request: Request) => {
      outboundViolations.push(new URL(request.url).href);
      return new Response('storage proof forbids outbound network', { status: 502 });
    },
  });
  options.workers[0].config.manifest = {
    mainModule: 'storage-proof.mjs', modulesRoot: temporary,
    modules: { 'storage-proof.mjs': { type: 'esm', contents: await readFile(scriptPath, 'utf8') } },
  };
  miniflare = new Miniflare(options);
  const db = await miniflare.getD1Database('DB');

  progress('applying all repository migrations through the shared safe splitter and D1.batch');
  const migrationFiles = (await readdir(resolve('migrations'))).filter(name => name.endsWith('.sql')).sort();
  const migrations: Array<{ file: string; statements: number }> = [];
  let schemaSql = '';
  for (const file of migrationFiles) {
    const sql = await readFile(resolve('migrations', file), 'utf8');
    schemaSql += sql;
    const statements = migrationStatements(sql);
    assert.ok(statements.length > 0, `empty migration ${file}`);
    const results = await db.batch(statements.map(statement => db.prepare(statement)));
    assert.ok(results.every(result => result.success), `migration batch failed: ${file}`);
    migrations.push({ file, statements: statements.length });
  }
  const schemaObjects = (await db.prepare(
    "SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
  ).all()).results as Array<{ type: string; name: string }>;
  const tables = schemaObjects.filter(object => object.type === 'table').map(object => object.name);
  const triggers = schemaObjects.filter(object => object.type === 'trigger').map(object => object.name);
  for (const table of INGRESS_TABLES) assert.ok(tables.includes(table), `missing table ${table}`);
  for (const trigger of INGRESS_TRIGGERS) assert.ok(triggers.includes(trigger), `missing trigger ${trigger}`);
  const schemaSha256 = sha256(new TextEncoder().encode(schemaSql));

  async function post(path: string, body: unknown): Promise<{ status: number; durationMs: number; json: Record<string, unknown> }> {
    const start = performance.now();
    const response = await miniflare!.dispatchFetch('https://local' + path, {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    });
    const durationMs = performance.now() - start;
    return { status: response.status, durationMs, json: await response.json() as Record<string, unknown> };
  }

  function signedHeaders(raw: string): Record<string, string> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', SIGNING_SECRET).update(`v0:${timestamp}:${raw}`).digest('hex');
    return { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': 'v0=' + signature, 'content-type': 'application/json' };
  }

  async function postAccept(eventId: string, text: string, root: string): Promise<{ status: number; durationMs: number; json: Record<string, unknown> }> {
    const raw = probeEventRaw(eventId, text, root);
    const start = performance.now();
    const response = await miniflare!.dispatchFetch('https://local/probe/accept', { method: 'POST', body: raw, headers: signedHeaders(raw) });
    const durationMs = performance.now() - start;
    return { status: response.status, durationMs, json: await response.json() as Record<string, unknown> };
  }

  const opened = await post('/probe/control', { state: 'open' });
  assert.equal(opened.status, 200);

  progress('measuring 24 signed acceptance requests');
  const sequentialTrials: Array<{ eventId: string; durationMs: number; queries: number }> = [];
  for (let index = 1; index <= 24; index++) {
    const eventId = `S${String(index).padStart(3, '0')}`;
    const raw = probeEventRaw(eventId, `local storage proof 世界🙂 #${index}`, `${index}.0`);
    const expected = { digest: sha256(new TextEncoder().encode(raw)), bytes: new TextEncoder().encode(raw).length };
    const result = await postAccept(eventId, `local storage proof 世界🙂 #${index}`, `${index}.0`);
    assert.equal(result.status, 200);
    assert.equal(result.json.status, 'accepted');
    assert.equal(result.json.duplicate, false);
    assert.equal(result.json.providerDigest, expected.digest);
    assert.equal(result.json.providerByteCount, expected.bytes);
    assert.ok(result.json.queries as number <= QUERY_BUDGET);
    assert.ok(result.durationMs < ACCEPT_WINDOW_MS, `acceptance ${eventId} took ${result.durationMs}ms`);
    sequentialTrials.push({ eventId, durationMs: result.durationMs, queries: result.json.queries as number });
  }

  progress('measuring concurrent duplicate acceptances');
  const concurrentTrials: Array<{ eventId: string; durationMs: number; queries: number }> = [];
  for (let event = 25; event <= 32; event++) {
    const eventId = `S${String(event).padStart(3, '0')}`;
    const raw = probeEventRaw(eventId, 'concurrent duplicate proof 世界🙂', `${event}.0`);
    const expectedDigest = sha256(new TextEncoder().encode(raw));
    const start = performance.now();
    const responses = await Promise.all([0, 1, 2, 3].map(() => miniflare!.dispatchFetch('https://local/probe/accept', {
      method: 'POST', body: raw, headers: signedHeaders(raw),
    }).then(async response => ({ status: response.status, json: await response.json() as Record<string, unknown> }))));
    const wallMs = performance.now() - start;
    assert.ok(responses.every(response => response.status === 200));
    assert.ok(responses.every(response => response.json.status === 'accepted'));
    assert.equal(new Set(responses.map(response => response.json.id as string)).size, 1);
    assert.equal(responses.filter(response => response.json.duplicate === false).length, 1);
    assert.equal(responses.filter(response => response.json.duplicate === true).length, 3);
    assert.ok(responses.every(response => response.json.providerDigest === expectedDigest));
    assert.ok(responses.every(response => response.json.queries as number <= QUERY_BUDGET));
    const rowCount = await db.prepare('SELECT COUNT(*) AS n FROM slack_ingress WHERE team_id=? AND event_id=?')
      .bind('T', eventId).first<{ n: number }>();
    assert.equal(rowCount?.n, 1);
    concurrentTrials.push({ eventId, durationMs: wallMs, queries: Math.max(...responses.map(response => response.json.queries as number)) });
  }

  progress('verifying lost response, mismatch, and closed-intake behavior');
  const lostRaw = probeEventRaw('S033-lost', 'lost response proof 世界🙂', '33.0');
  const first = await postAccept('S033-lost', 'lost response proof 世界🙂', '33.0');
  assert.equal(first.json.status, 'accepted');
  assert.equal(first.json.duplicate, false); // response is intentionally discarded (simulated loss)
  const retried = await postAccept('S033-lost', 'lost response proof 世界🙂', '33.0');
  assert.equal(retried.json.status, 'accepted');
  assert.equal(retried.json.duplicate, true);
  assert.equal(retried.json.id, first.json.id);
  assert.ok(retried.durationMs < ACCEPT_WINDOW_MS);
  const lostRows = await db.prepare('SELECT COUNT(*) AS n, MAX(digest) AS digest FROM slack_ingress WHERE team_id=? AND event_id=?')
    .bind('T', 'S033-lost').first<{ n: number; digest: string }>();
  assert.equal(lostRows?.n, 1);
  assert.equal(lostRows?.digest, sha256(new TextEncoder().encode(lostRaw)));

  const mismatch = await postAccept('S033-lost', 'changed payload 世界🙂 mismatch', '33.0');
  assert.equal(mismatch.json.status, 'conflict');
  assert.ok(mismatch.durationMs < ACCEPT_WINDOW_MS);
  const afterMismatch = await db.prepare('SELECT digest FROM slack_ingress WHERE team_id=? AND event_id=?')
    .bind('T', 'S033-lost').first<{ digest: string }>();
  assert.equal(afterMismatch?.digest, sha256(new TextEncoder().encode(lostRaw)));

  await post('/probe/control', { state: 'closed' });
  const closedNew = await postAccept('S034-closed', 'closed intake proof', '34.0');
  assert.equal(closedNew.json.status, 'closed');
  const closedDuplicate = await postAccept('S033-lost', 'lost response proof 世界🙂', '33.0');
  assert.equal(closedDuplicate.json.status, 'accepted');
  assert.equal(closedDuplicate.json.duplicate, true);
  assert.ok(closedDuplicate.durationMs < ACCEPT_WINDOW_MS);
  const closedRowCount = await db.prepare("SELECT COUNT(*) AS n FROM slack_ingress WHERE event_id='S034-closed'").first<{ n: number }>();
  assert.equal(closedRowCount?.n, 0);
  await post('/probe/control', { state: 'open' });

  const acceptanceDurations = [
    ...sequentialTrials.map(trial => trial.durationMs),
    ...concurrentTrials.map(trial => trial.durationMs),
    retried.durationMs, mismatch.durationMs, closedNew.durationMs, closedDuplicate.durationMs,
  ];
  assert.ok(acceptanceDurations.length >= 20);
  assert.ok(acceptanceDurations.every(duration => duration < ACCEPT_WINDOW_MS));
  const allQueryCounts = [...sequentialTrials, ...concurrentTrials].map(trial => trial.queries);
  assert.ok(Math.max(...allQueryCounts) <= QUERY_BUDGET);

  progress('storing and reloading a small mixed-UTF-8 request');
  const textEventId = 'STORE-TEXT';
  const expectedText = probeTextRequest(textEventId);
  const expectedTextBytes = frozenRequestBytes(expectedText);
  const textStore = await post('/probe/store', { eventId: textEventId, utf8: false });
  assert.equal(textStore.status, 200);
  assert.equal(textStore.json.stored, true);
  assert.equal((textStore.json.chunks as Record<string, number>).count, 1);
  assert.equal((textStore.json.chunks as Record<string, number>).max_bytes, expectedTextBytes.length);
  assert.equal((textStore.json.manifest as Record<string, unknown>).total_bytes, expectedTextBytes.length);
  assert.equal((textStore.json.manifest as Record<string, unknown>).digest, sha256(expectedTextBytes));
  assert.equal(textStore.json.producerRetained, 1);
  assert.ok(textStore.json.queries as number <= QUERY_BUDGET);
  const textLoad = await post('/probe/load', { ingressId: textStore.json.ingressId, eventId: textEventId, utf8: false });
  assert.equal(textLoad.json.ok, true);
  assert.equal(textLoad.json.replayIdentical, true);
  assert.equal(textLoad.json.digest, sha256(expectedTextBytes));
  assert.equal(textLoad.json.byteCount, expectedTextBytes.length);
  assert.ok(textLoad.json.queries as number <= QUERY_BUDGET);

  progress('storing and reassembling the near-limit 11,495,904-byte mixed-UTF-8 request');
  const expectedBig = utf8PaddedRequest(NEAR_LIMIT_ENVELOPE_BYTES);
  const expectedBigBytes = frozenRequestBytes(expectedBig);
  assert.equal(new TextEncoder().encode(JSON.stringify({ agent: 'project', ...expectedBig })).length, NEAR_LIMIT_ENVELOPE_BYTES);
  const heapBeforeStore = process.memoryUsage().heapUsed;
  const bigStore = await post('/probe/store', { eventId: 'STORE-UTF8-MAX', utf8: true, targetBytes: NEAR_LIMIT_ENVELOPE_BYTES });
  const heapAfterStore = process.memoryUsage().heapUsed;
  assert.equal(bigStore.status, 200);
  assert.equal(bigStore.json.stored, true);
  const bigChunks = bigStore.json.chunks as Record<string, number>;
  const bigManifest = bigStore.json.manifest as Record<string, unknown>;
  assert.equal(bigChunks.count, 12);
  assert.equal(bigChunks.first_ordinal, 0);
  assert.equal(bigChunks.last_ordinal, 11);
  assert.ok(bigChunks.max_bytes <= 1_000_000);
  assert.ok(bigChunks.min_bytes > 0);
  assert.equal(bigChunks.sum_bytes, expectedBigBytes.length);
  assert.equal(bigManifest.total_bytes, expectedBigBytes.length);
  assert.equal(bigManifest.chunk_count, 12);
  assert.equal(bigManifest.digest, sha256(expectedBigBytes));
  assert.equal((bigStore.json.row as Record<string, unknown>).state, 'ready');
  assert.equal(bigStore.json.producerRetained, 1);
  assert.ok(bigStore.json.queries as number <= QUERY_BUDGET);

  const heapBeforeLoad = process.memoryUsage().heapUsed;
  const bigLoad = await post('/probe/load', { ingressId: bigStore.json.ingressId, eventId: 'E1', utf8: true, targetBytes: NEAR_LIMIT_ENVELOPE_BYTES });
  const heapAfterLoad = process.memoryUsage().heapUsed;
  assert.equal(bigLoad.json.ok, true);
  assert.equal(bigLoad.json.replayIdentical, true);
  assert.equal(bigLoad.json.digest, sha256(expectedBigBytes));
  assert.equal(bigLoad.json.byteCount, expectedBigBytes.length);
  assert.ok(bigLoad.json.queries as number <= QUERY_BUDGET);

  progress('verifying missing/corrupt storage fails closed with rows retained');
  const faults: Array<{ mode: string; failedClosed: boolean; retained: Record<string, unknown>; droppedTrigger: string }> = [];
  for (const [mode, eventId] of [['missing-chunk', 'FAULT-MISSING'], ['corrupt-chunk', 'FAULT-CORRUPT'], ['corrupt-manifest-digest', 'FAULT-DIGEST']] as const) {
    const stored = await post('/probe/store', { eventId, utf8: false });
    assert.equal(stored.json.stored, true);
    const faulted = await post('/probe/fault', { ingressId: stored.json.ingressId, mode });
    assert.equal(faulted.status, 200);
    assert.equal(faulted.json.failedClosed, true);
    assert.equal(faulted.json.errorName, 'FrozenRequestInvalid');
    const retained = faulted.json.retained as Record<string, unknown>;
    assert.equal(retained.manifest_rows, 1);
    assert.equal(retained.state, 'ready');
    assert.equal(retained.manifest_id, stored.json.manifestId);
    assert.equal(retained.producer_rows, 1);
    if (mode !== 'missing-chunk') assert.equal(retained.chunk_rows, 1);
    faults.push({ mode, failedClosed: faulted.json.failedClosed as boolean, retained, droppedTrigger: faulted.json.droppedTrigger as string });
  }

  assert.deepEqual(outboundViolations, []);
  const health = await miniflare.dispatchFetch('https://local/probe/health');
  assert.equal((await health.json() as Record<string, unknown>).ok, true);
  const retainedChunks = await db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(length(bytes)),0) AS bytes FROM slack_ingress_chunks')
    .first<{ n: number; bytes: number }>();
  const retainedEvents = await db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(length(event_json)),0) AS bytes FROM slack_ingress')
    .first<{ n: number; bytes: number }>();

  await cleanup();
  assert.ok(!existsSync(temporary));

  const evidence = {
    proof: 'local Miniflare D1 ingress storage proof',
    mode: 'local',
    safety,
    cleanup: { status: 'disposed and removed own temp dir after readback', ownDirOnly: true,
      interruptedRunPolicy: 'retained; this script never scans or deletes other probe-prefixed temp dirs',
      explicitResumeById: 'not implemented (optional future feature)' },
    localConditions: {
      declared: 'local Miniflare D1 on this machine only; no universal or remote SLA claim',
      slackAcceptanceWindowMs: ACCEPT_WINDOW_MS, node: process.version, platform: process.platform,
      cpuModel: cpus()[0]?.model ?? null, cpuCores: cpus().length, nodeTotalMemoryBytes: totalmem(),
      workerMemoryPlatformAvailable: false,
      workerMemoryNote: 'Workers platform memory telemetry is unavailable under local Miniflare; reported heap deltas are Node driver-side only.',
      driverHeapDeltaStoreBytes: heapAfterStore - heapBeforeStore,
      driverHeapDeltaLoadBytes: heapAfterLoad - heapBeforeLoad,
    },
    migrations: { files: migrations.length, statements: migrations.reduce((sum, entry) => sum + entry.statements, 0), detail: migrations,
      schemaSha256, schemaShaNote: 'SHA-256 over every migration file concatenated in sorted file order (exact bytes applied)',
      artifactSha256, artifactShaNote: 'SHA-256 over the esbuild-bundled probe Worker actually executed by Miniflare' },
    schema: { tables: tables.length, triggers: triggers.length, ingressTablesVerified: INGRESS_TABLES, ingressTriggersVerified: INGRESS_TRIGGERS },
    acceptance: {
      sequentialTrials: sequentialTrials.length, concurrentDuplicateGroups: concurrentTrials.length,
      concurrentRequestsPerGroup: 4, measuredResponses: acceptanceDurations.length,
      durationsMs: acceptanceDurations, trialDetails: [...sequentialTrials, ...concurrentTrials],
      duration: distribution(acceptanceDurations), everyResponseUnderSlackWindowMs: acceptanceDurations.every(d => d < ACCEPT_WINDOW_MS),
      maxQueriesPerInvocation: Math.max(...allQueryCounts), queryBudget: QUERY_BUDGET,
      lostResponseRetry: { duplicate: true, sameId: true, rows: 1 },
      payloadMismatch: { status: 'conflict', retainedOriginalDigest: true },
      closedIntake: { newEvent: 'closed', noRowCreated: true, existingDuplicateAccepted: true },
      productionDigestAndProviderBytesVerified: true,
    },
    storage: {
      smallRequest: { stored: true, chunks: 1, byteCount: expectedTextBytes.length, digest: sha256(expectedTextBytes),
        replayIdentical: true, storeDurationMs: textStore.durationMs, loadDurationMs: textLoad.durationMs,
        storeQueries: textStore.json.queries, loadQueries: textLoad.json.queries },
      nearLimitUtf8Request: {
        targetEnvelopeBytes: NEAR_LIMIT_ENVELOPE_BYTES, frozenByteCount: expectedBigBytes.length,
        digest: sha256(expectedBigBytes), chunkCount: 12, maxChunkBytes: bigChunks.max_bytes,
        minChunkBytes: bigChunks.min_bytes, chunkBytesSum: bigChunks.sum_bytes, chunkBound: 1_000_000,
        exactDigestAndByteCount: true, replayIdentical: true, producerRetained: 1,
        storeDurationMs: bigStore.durationMs, loadDurationMs: bigLoad.durationMs,
        storeQueries: bigStore.json.queries, loadQueries: bigLoad.json.queries,
        driverNote: 'storage/read durations are recorded, not gated against the Slack 3s acceptance window',
      },
      faults,
      retainedVolume: {
        chunkRows: retainedChunks?.n ?? 0, chunkBytes: retainedChunks?.bytes ?? 0,
        ingressRows: retainedEvents?.n ?? 0, eventJsonBytes: retainedEvents?.bytes ?? 0,
        projectedPerNearLimitRequestChunkBytes: expectedBigBytes.length,
        headroom: { status: 'unknown', reason: 'Remaining DB headroom requires an authorized disposable remote D1 target; remote is blocked, so no headroom claim is made.' },
      },
    },
    network: { outboundAttempts: outboundViolations.length, modelCalls: 0, slackCalls: 0 },
    remote: { status: 'blocked', acceptedImplementationLimitation: true, requiresLaterRemoteProbe: true,
      reason: 'No disposable remote D1 target is authorized; remote capacity, latency, and headroom cannot be proven locally, and remote completeness is not claimed.' },
  };
  console.log(JSON.stringify(evidence, null, 2));
  progress('local proof complete');
} catch (error) {
  await cleanup();
  process.stderr.write(`[d1-storage-proof] FAILED: ${(error as Error).stack}\n`);
  process.exit(1);
}
