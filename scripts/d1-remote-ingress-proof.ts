// Explicitly staged disposable-target proof. Never defaults to a production resource.
// Metadata/state snapshots are append-only; the probe credential lives in a private ignored file.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { frozenRequestBytes, probeEventRaw, probeTextRequest, utf8PaddedRequest, NEAR_LIMIT_ENVELOPE_BYTES } from './ingress-fixtures/storage-payload';

const ACCOUNT_ID = '6eb4dbc343e3665dc856443382e657c2';
const PRODUCTION_DATABASE_ID = '6ac5de79-a8c0-4e08-aab8-b9b636278a9d';
const root = resolve();
const evidenceRoot = join(root, '.superpowers/sdd/2026-10-01-flue-cutover-safety');
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const randomHex = (bytes: number) => Array.from(randomBytes(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const require_ = createRequire(import.meta.url);
interface Manifest {
  schema: 1; probeId: string; accountId: string; databaseName: string; workerName: string;
  directory: string; tokenFile: string; artifact: string; artifactSha256: string; schemaSha256: string;
  migrationHashes: Record<string, string>; phase: string; sequence: number;
  databaseId?: string; config?: string; url?: string; resultsFile?: string; resultsSha256?: string;
  observations?: Observation[]; [key: string]: unknown;
}
interface Observation { path: string; status: number; durationMs: number; queries: number; body: Record<string, any> }
function validate(m: Manifest) {
  assert.equal(m.schema, 1); assert.equal(m.accountId, ACCOUNT_ID);
  assert.match(m.probeId, /^[a-f0-9]{16}$/);
  assert.equal(m.databaseName, `morehands-cutover-db-${m.probeId}`);
  assert.equal(m.workerName, `morehands-cutover-probe-${m.probeId}`);
  assert.equal(resolve(m.directory), join(evidenceRoot, `remote-probe-${m.probeId}`));
  assert.equal(resolve(m.tokenFile), join(m.directory, 'probe-token.private'));
  if (m.databaseId) { assert.match(m.databaseId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/); assert.notEqual(m.databaseId, PRODUCTION_DATABASE_ID); }
  if (m.url) { const u = new URL(m.url); assert.equal(u.protocol, 'https:'); assert.ok(u.hostname.startsWith(m.workerName + '.') && u.hostname.endsWith('.workers.dev')); assert.equal(u.username + u.password + u.search + u.hash, ''); }
}
const snapshotQueues = new WeakMap<Manifest, Promise<void>>();
async function snapshot(m: Manifest, phase: string, extra: Record<string, unknown> | ((current: Manifest) => Record<string, unknown>) = {}) {
  const job = (snapshotQueues.get(m) ?? Promise.resolve()).then(async () => {
    const additions = typeof extra === 'function' ? extra(m) : extra;
    const next = { ...m, ...additions, phase, sequence: m.sequence + 1, recordedAt: new Date().toISOString() };
    validate(next);
    await writeFile(join(m.directory, `state-${String(next.sequence).padStart(4, '0')}.json`), JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    Object.assign(m, next);
  });
  snapshotQueues.set(m, job.catch(() => {}));
  await job;
}
async function load(path: string): Promise<Manifest> {
  const initial = JSON.parse(await readFile(resolve(path), 'utf8')) as Manifest;
  validate(initial);
  const snapshots = (await readdir(initial.directory)).filter(n => /^state-\d{4}\.json$/.test(n)).sort();
  const m = snapshots.length ? JSON.parse(await readFile(join(initial.directory, snapshots.at(-1)!), 'utf8')) as Manifest : initial;
  validate(m); assert.equal(m.probeId, initial.probeId);
  assert.equal(sha(await readFile(m.artifact)), m.artifactSha256, 'probe artifact changed');
  for (const [file, digest] of Object.entries(m.migrationHashes)) assert.equal(sha(await readFile(file)), digest, 'migration changed after preparation');
  assert.equal((await stat(m.tokenFile)).mode & 0o777, 0o600);
  return m;
}
async function cli(m: Manifest, args: string[], input?: string): Promise<string> {
  // No shell interpolation, secret arguments, raw CLI logs, or inherited project .env files.
  const started = performance.now();
  const result = await new Promise<{ exit: number; stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args, '--env-file', join(m.directory, 'empty.env')],
      { cwd: m.directory, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: m.accountId, WRANGLER_SEND_METRICS: 'false',
        WRANGLER_LOG: 'log', WRANGLER_LOG_SANITIZE: 'true', WRANGLER_WRITE_LOGS: 'false' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', code => accept({ exit: code ?? 1, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
  await snapshot(m, m.phase, { lastCli: { args, exitCode: result.exit, durationMs: performance.now() - started,
    stdoutSha256: sha(result.stdout), stderrSha256: sha(result.stderr) } });
  assert.equal(result.exit, 0, `Wrangler ${args.slice(0, 2).join(' ')} failed; raw credential-bearing output was not retained`);
  return result.stdout;
}
function workerConfig(m: Manifest) {
  return { name: m.workerName, account_id: m.accountId, main: m.artifact, compatibility_date: '2026-06-09',
    workers_dev: true, preview_urls: false, observability: { enabled: false },
    d1_databases: m.databaseId ? [{ binding: 'DB', database_name: m.databaseName, database_id: m.databaseId, migrations_dir: join(root, 'migrations') }] : [],
    vars: { PROBE_ID: m.probeId, PROBE_DATABASE_ID: m.databaseId ?? '', PROBE_DATABASE_NAME: m.databaseName } };
}
async function prepare(probeId: string) {
  assert.match(probeId, /^[a-f0-9]{16}$/);
  const directory = join(evidenceRoot, `remote-probe-${probeId}`);
  await mkdir(directory, { mode: 0o700 }); // No recursive/reuse: a prior owned run must resume explicitly.
  const artifact = join(directory, 'probe-worker.mjs');
  await require_('esbuild').build({ entryPoints: [join(root, 'scripts/ingress-fixtures/remote-storage-entry.ts')], outfile: artifact,
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', legalComments: 'none' });
  const migrationHashes: Record<string, string> = {};
  let migrationBytes = '';
  for (const name of (await readdir(join(root, 'migrations'))).filter(n => n.endsWith('.sql')).sort()) {
    const file = join(root, 'migrations', name); const bytes = await readFile(file);
    migrationHashes[file] = sha(bytes); migrationBytes += bytes.toString();
  }
  const m: Manifest = { schema: 1, probeId, accountId: ACCOUNT_ID, databaseName: `morehands-cutover-db-${probeId}`,
    workerName: `morehands-cutover-probe-${probeId}`, directory, tokenFile: join(directory, 'probe-token.private'),
    artifact, artifactSha256: sha(await readFile(artifact)), schemaSha256: sha(migrationBytes), migrationHashes, phase: 'prepared', sequence: 0 };
  validate(m);
  await writeFile(m.tokenFile, randomHex(32), { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'empty.env'), '', { flag: 'wx', mode: 0o600 });
  m.config = join(directory, 'wrangler-preprovision.json');
  await writeFile(m.config, JSON.stringify(workerConfig(m), null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(m, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ phase: m.phase, manifest: join(directory, 'manifest.json'), accountId: m.accountId,
    databaseName: m.databaseName, workerName: m.workerName, artifactSha256: m.artifactSha256, schemaSha256: m.schemaSha256 }));
}
async function provision(m: Manifest) {
  assert.equal(m.phase, 'prepared'); assert.ok(!m.databaseId);
  const list = JSON.parse(await cli(m, ['d1', 'list', '--json', '--config', m.config!])) as Array<{ name: string }>;
  assert.ok(!list.some(d => d.name === m.databaseName), 'target name already exists; do not claim ownership');
  await snapshot(m, 'create-requested', { creationRequestedAt: new Date().toISOString(), nameAbsentBeforeCreate: true });
  const output = await cli(m, ['d1', 'create', m.databaseName, '--location', 'apac', '--update-config=false', '--config', m.config!]);
  const ids = [...new Set(output.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g) ?? [])];
  assert.equal(ids.length, 1, 'creation receipt is ambiguous; retain run and inspect before resuming');
  assert.notEqual(ids[0], PRODUCTION_DATABASE_ID);
  await snapshot(m, 'database-created', { databaseId: ids[0] });
  const config = join(m.directory, 'wrangler-provisioned.json');
  await writeFile(config, JSON.stringify(workerConfig(m), null, 2) + '\n', { flag: 'wx' });
  await snapshot(m, 'database-created', { config });
  const info = JSON.parse(await cli(m, ['d1', 'info', m.databaseName, '--json', '--config', config]));
  assert.equal(info.uuid, m.databaseId); assert.equal(info.name, m.databaseName);
  assert.equal(Number(info.num_tables), 0, 'probe database must be empty before schema setup');
  await cli(m, ['d1', 'migrations', 'apply', m.databaseName, '--remote', '--config', config]);
  const ownership = join(m.directory, 'ownership.sql');
  await writeFile(ownership,
    'CREATE TABLE probe_ownership(id INTEGER PRIMARY KEY,probe_id TEXT NOT NULL,database_id TEXT NOT NULL,database_name TEXT NOT NULL);\n'
    + `INSERT INTO probe_ownership VALUES(1,'${m.probeId}','${m.databaseId}','${m.databaseName}');\n`
    + 'CREATE TABLE probe_guard_definitions(name TEXT PRIMARY KEY,sql TEXT NOT NULL);\n'
    + "INSERT INTO probe_guard_definitions SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'slack_ingress_%';\n", { flag: 'wx' });
  await cli(m, ['d1', 'execute', m.databaseName, '--remote', '--file', ownership, '--yes', '--config', config]);
  await snapshot(m, 'schema-ready');
}
async function deploy(m: Manifest) {
  assert.equal(m.phase, 'schema-ready'); assert.ok(m.databaseId);
  await cli(m, ['deploy', '--dry-run', '--config', m.config!]);
  // Prove the random name is unoccupied before secret-put can create a temporary Worker.
  await cli(m, ['whoami', '--json', '--config', m.config!]); // Refresh the existing OAuth session if needed.
  const authFile = join(homedir(), 'Library/Preferences/.wrangler/config/default.toml');
  const auth = process.env.CLOUDFLARE_API_TOKEN
    ?? (await readFile(authFile, 'utf8')).match(/^oauth_token\s*=\s*"([^"\r\n]+)"/m)?.[1];
  assert.ok(auth, 'Cloudflare authentication unavailable');
  const existing = await fetch(`https://api.cloudflare.com/client/v4/accounts/${m.accountId}/workers/scripts/${m.workerName}`,
    { headers: { authorization: `Bearer ${auth}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  await existing.body?.cancel();
  assert.ok(![401, 403].includes(existing.status), 'Cloudflare authentication or permission failed before Worker ownership check');
  assert.equal(existing.status, 404, 'temporary Worker name is occupied or its ownership is unknown');
  await snapshot(m, 'schema-ready', { workerNameAbsentBeforeDeployment: true });
  // The temporary Worker has one D1 binding and no production/native bindings or crons.
  await cli(m, ['secret', 'put', 'PROBE_TOKEN', '--config', m.config!], (await readFile(m.tokenFile, 'utf8')) + '\n');
  const output = await cli(m, ['deploy', '--config', m.config!]);
  const urls = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/g) ?? [];
  const url = urls.find(u => new URL(u).hostname.startsWith(m.workerName + '.'));
  assert.ok(url, 'deployment URL missing; do not guess a target');
  await snapshot(m, 'deployed', { url });
}
async function transport(m: Manifest) {
  assert.ok(m.url); validate(m);
  const credential = (await readFile(m.tokenFile, 'utf8')).trim(); assert.match(credential, /^[a-f0-9]{64}$/);
  return async (path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Observation> => {
    const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const start = performance.now();
    const response = await fetch(m.url! + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: AbortSignal.timeout(30_000), body: body === undefined ? undefined : raw,
      headers: { 'user-agent': 'MoreHandsIsolatedProof/1', 'content-type': 'application/json', 'x-probe-token': credential,
        ...(path === '/probe/accept' ? { 'x-slack-request-timestamp': timestamp,
          'x-slack-signature': 'v0=' + createHmac('sha256', credential).update(`v0:${timestamp}:${raw}`).digest('hex') } : {}), ...extra } });
    const responseText = await response.text();
    let responseBody: Record<string, any>;
    try { responseBody = JSON.parse(responseText); }
    catch { responseBody = { invalidJson: true, responseBytes: Buffer.byteLength(responseText), responseSha256: sha(responseText) }; }
    const result: Observation = { path, status: response.status, durationMs: performance.now() - start,
      queries: Number(response.headers.get('x-probe-query-total')), body: responseBody };
    // Append inside the same queue as the write. Concurrent replies must not overwrite
    // one another, and a failed gate's response must be saved before assertion.
    await snapshot(m, m.phase, current => ({ observations: [...(current.observations ?? []), result] }));
    assert.ok(result.queries > 0 && result.queries <= 50, 'missing or excessive platform statement accounting');
    return result;
  };
}
async function runProof(m: Manifest) {
  assert.ok(['deployed', 'proof-running'].includes(m.phase), 'a known failed gate needs disposition; do not silently rerun');
  const request = await transport(m); await snapshot(m, 'proof-running');
  const health = await request('/probe/health'); assert.equal(health.status, 200); assert.equal(health.body.probeId, m.probeId);
  assert.equal(health.body.databaseId, m.databaseId);
  assert.ok(health.body.cleanupStatements <= 50, 'guard restoration exceeds physical invocation budget');
  assert.equal((await request('/probe/control', { state: 'open' })).status, 200);
  const acceptance: Observation[] = [];
  for (let i = 1; i <= 24; i++) {
    const eventId = `${m.probeId}-A${i}`;
    const raw = probeEventRaw(eventId, `synthetic database proof 世界🙂 ${i}`, `${i}.0`);
    const result = await request('/probe/accept', raw);
    assert.equal(result.status, 200); assert.equal(result.body.status, 'accepted'); assert.equal(result.body.providerDigest, sha(raw));
    assert.ok(result.durationMs < 3000, 'signed acceptance exceeded Slack window'); acceptance.push(result);
  }
  // Serialize snapshot writes; parallel HTTP requests still compete on the actual remote binding.
  for (let i = 25; i <= 28; i++) {
    const raw = probeEventRaw(`${m.probeId}-A${i}`, 'concurrent duplicate 世界🙂', `${i}.0`);
    const responses = await Promise.all([0, 1, 2, 3].map(() => request('/probe/accept', raw)));
    assert.ok(responses.every(r => r.status === 200 && r.body.status === 'accepted' && r.durationMs < 3000));
    assert.equal(new Set(responses.map(r => r.body.id)).size, 1);
    // On resumed trials all four may be duplicates; inspect the one original durable row below.
    assert.ok(responses.filter(r => r.body.duplicate === false).length <= 1);
    const inspected = await request('/probe/inspect', { eventId: `${m.probeId}-A${i}` });
    assert.equal(inspected.body.row.event_rows, 1); assert.equal(inspected.body.row.producer_rows, 1);
    acceptance.push(...responses);
  }
  const lossId = `${m.probeId}-LOSS`;
  const lossRaw = probeEventRaw(lossId, 'lost response synthetic 世界🙂', '99.0');
  const lost = await request('/probe/accept', lossRaw, { 'x-probe-drop-accept-response': '1' }); assert.equal(lost.status, 503);
  const healed = await request('/probe/accept', lossRaw); assert.equal(healed.body.duplicate, true); assert.ok(healed.durationMs < 3000); acceptance.push(healed);
  assert.equal((await request('/probe/inspect', { eventId: lossId })).body.row.producer_rows, 1);
  const conflict = await request('/probe/accept', probeEventRaw(lossId, 'changed bytes', '99.0')); assert.equal(conflict.body.status, 'conflict');
  await request('/probe/control', { state: 'closed' });
  assert.equal((await request('/probe/accept', probeEventRaw(`${m.probeId}-CLOSED`, 'closed', '100.0'))).body.status, 'closed');
  assert.equal((await request('/probe/accept', lossRaw)).body.duplicate, true);
  await request('/probe/control', { state: 'open' });
  const storage: Array<Record<string, unknown>> = [];
  const large = utf8PaddedRequest(); const expectedBytes = frozenRequestBytes(large); const expectedDigest = sha(expectedBytes);
  for (let i = 1; i <= 20; i++) {
    const eventId = `${m.probeId}-L${i}`; const input = { eventId, utf8: true, requestDigest: expectedDigest };
    if (i === 1) assert.equal((await request('/probe/store', input, { 'x-probe-drop-store-response': '1' })).status, 503);
    const stored = await request('/probe/store', input); assert.equal(stored.status, 200); assert.equal(stored.body.stored, true);
    const loaded = await request('/probe/load', { eventId, utf8: true, ingressId: `storage-proof:${eventId}` });
    assert.equal(loaded.status, 200); assert.equal(loaded.body.digest, expectedDigest); assert.equal(loaded.body.byteCount, expectedBytes.length); assert.equal(loaded.body.replayIdentical, true);
    const row = (await request('/probe/inspect', { eventId })).body.row;
    assert.equal(row.chunk_rows, 12); assert.equal(row.producer_rows, 1); assert.equal(row.frozen_digest, expectedDigest);
    storage.push({ eventId, bytes: expectedBytes.length, digest: expectedDigest, storeMs: stored.durationMs, loadMs: loaded.durationMs,
      storeQueries: stored.queries, loadQueries: loaded.queries, chunks: row.chunk_rows });
  }
  for (const [i, mode] of ['missing-chunk', 'corrupt-chunk', 'corrupt-manifest-digest'].entries()) {
    const eventId = `${m.probeId}-F${i}`; const requestDigest = sha(frozenRequestBytes(probeTextRequest(eventId)));
    // A previous process may have already applied this deliberate fault. Preserve
    // that row and repeat the idempotent fault proof, never republish its payload.
    const existing = (await request('/probe/inspect', { eventId })).body.row;
    if (!existing) assert.equal((await request('/probe/store', { eventId, utf8: false, requestDigest })).body.stored, true);
    else assert.equal(existing.producer_rows, 1);
    const fault = await request('/probe/fault', { ingressId: `storage-proof:${eventId}`, mode });
    assert.equal(fault.body.failedClosed, true); assert.equal(fault.body.retained.producer_rows, 1);
  }
  const results = { proof: 'isolated remote D1 Worker-binding proof', probeId: m.probeId, accountId: m.accountId,
    databaseId: m.databaseId, workerName: m.workerName, artifactSha256: m.artifactSha256, schemaSha256: m.schemaSha256,
    successfulAcceptanceTrials: acceptance.length, maxAcceptanceMs: Math.max(...acceptance.map(r => r.durationMs)),
    maxQueries: Math.max(...m.observations!.map(r => r.queries)), storageTrials: storage,
    envelopeBytes: NEAR_LIMIT_ENVELOPE_BYTES, frozenBytes: expectedBytes.length,
    exactReplay: true, lostCommittedResponsesRecovered: true, corruptStorageRetained: true,
    peakWorkerMemoryBytes: null, platformMemoryScope: 'actual largest requests completed on remote Worker; unused peak memory not measured',
    network: { modelCalls: 0, slackCalls: 0, productionMutations: 0 }, observations: m.observations };
  const file = join(m.directory, `results-${String(m.sequence + 1).padStart(4, '0')}-${randomHex(8)}.json`);
  await writeFile(file, JSON.stringify(results, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await snapshot(m, 'proof-complete', { resultsFile: file, resultsSha256: sha(await readFile(file)) });
  console.log(JSON.stringify({ phase: m.phase, resultsFile: file, acceptanceTrials: acceptance.length, maxAcceptanceMs: results.maxAcceptanceMs, storageTrials: storage.length, peakWorkerMemoryBytes: null }));
}
async function cleanup(m: Manifest) {
  assert.ok(['proof-complete', 'cleanup-requested', 'cleaned'].includes(m.phase));
  assert.ok(m.resultsFile && m.resultsSha256); assert.equal(sha(await readFile(m.resultsFile)), m.resultsSha256);
  const request = await transport(m); await snapshot(m, 'cleanup-requested');
  // An interrupted driver can issue this again under the same ID; the server restores all guards atomically.
  const unknown = await request('/probe/cleanup', { probeId: m.probeId, savedEvidenceSha256: m.resultsSha256 },
    { 'x-probe-drop-cleanup-response': '1' });
  assert.equal(unknown.status, 503);
  const result = await request('/probe/cleanup', { probeId: m.probeId, savedEvidenceSha256: m.resultsSha256 });
  assert.equal(result.status, 200); assert.deepEqual(result.body.counts, { events: 0, producers: 0, chunks: 0, manifests: 0 });
  assert.ok(result.body.guardsRestored > 0);
  const repeated = await request('/probe/cleanup', { probeId: m.probeId, savedEvidenceSha256: m.resultsSha256 });
  assert.equal(repeated.status, 200); assert.deepEqual(repeated.body.counts, result.body.counts);
  assert.equal(repeated.body.guardsRestored, result.body.guardsRestored);
  await snapshot(m, 'cleaned', { cleanupVerified: true });
  console.log(JSON.stringify({ phase: m.phase, probeId: m.probeId, scopedRows: result.body.counts, guardsRestored: result.body.guardsRestored }));
}
const [mode, value, ...extra] = process.argv.slice(2);
assert.ok(!extra.length, 'unexpected arguments');
try {
  if (mode === '--prepare' && value) await prepare(value);
  else if (['--provision', '--deploy', '--run', '--resume', '--cleanup'].includes(mode) && value) {
    const m = await load(value);
    try {
      if (mode === '--provision') await provision(m);
      else if (mode === '--deploy') await deploy(m);
      else if (mode === '--cleanup') await cleanup(m);
      else await runProof(m);
    } catch (error) {
      await snapshot(m, 'failed', { failure: error instanceof Error ? error.message : 'unknown failure' });
      throw error;
    }
  } else throw new Error('Usage: d1-remote-ingress-proof.ts --prepare <16hex-probe-id> | --provision|--deploy|--run|--resume|--cleanup <manifest.json>');
} catch (error) {
  console.error(JSON.stringify({ status: 'held', error: error instanceof Error ? error.message : 'unknown failure', productionMutations: 0 }));
  process.exitCode = 1;
}
