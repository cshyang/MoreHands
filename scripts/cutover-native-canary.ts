import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { InstanceObservation } from '../src/cutover/observation';

const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { build } = require('esbuild');
const configPath = resolve('dist/hatchery/wrangler.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const artifactRoot = dirname(configPath);
const temporary = await mkdtemp(join(tmpdir(), 'morehands-native-cutover-'));
const scriptPath = join(temporary, 'entry.mjs');
// Preserve the emitted runtime's module boundaries. Rebundling the artifact
// fails workerd startup; only the test entry needs TypeScript compilation.
await build({ entryPoints: [resolve('scripts/cutover-fixtures/native-entry.ts')], outfile: scriptPath,
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  plugins: [{ name: 'native-artifact', setup(builder: any) {
    builder.onResolve({ filter: /^cutover-native-artifact$/ }, () => ({ path: `./${config.main}`, external: true }));
  } }],
});
const modules: Record<string, { type: 'esm'; contents: string }> = {
  'canary.mjs': { type: 'esm', contents: await readFile(scriptPath, 'utf8') },
};
for (const file of await readdir(artifactRoot, { recursive: true })) {
  if (file.endsWith('.js')) modules[file] = { type: 'esm', contents: await readFile(join(artifactRoot, file), 'utf8') };
}
// Installed Miniflare 5 exports its legacy-option converter; persistence is
// instance-wide in this version, not the old durableObjectsPersist option.
const options = convertV4MiniflareOptions({ name: 'local-cutover-canary', modules: true, scriptPath,
  // Production runs compatibility_date 2026-06-09; match it so RPC behavior in the
  // canary reflects the deployed workerd semantics rather than a newer date.
  compatibilityDate: '2026-06-09', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { TEST_AGENT: { className: 'LocalCanary', useSQLite: true } },
  resourcePersistencePath: join(temporary, 'sqlite'),
  telemetry: { enabled: false },
  outboundService: () => { throw new Error('local canary forbids network'); },
});
options.workers[0].config.manifest = { mainModule: 'canary.mjs', modulesRoot: artifactRoot, modules };
const observe = async (mf: InstanceType<typeof Miniflare>): Promise<InstanceObservation> => {
  const response = await mf.dispatchFetch('http://local/observe');
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};
let mf = new Miniflare(options);
try {
  // Characterize the real artifact, not the VM ingress fixture's runtime mock.
  // Accidentally exposing Project HTTP transport would contact the trap namespace.
  for (const method of ['GET', 'HEAD', 'POST', 'DELETE']) {
    const response = await mf.dispatchFetch('http://local/public/agents/project/arbitrary', { method });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('x-local-namespace-accesses'), '0');
  }
  console.log('Native emitted Worker rejects public Project HTTP without namespace access.');
  const identityResponse = await mf.dispatchFetch('http://local/identity');
  assert.equal(identityResponse.status, 200, await identityResponse.clone().text());
  const identity = await identityResponse.json() as { identities: { instanceName: string; objectId: string }[] };
  assert.deepEqual(identity.identities.map(entry => entry.instanceName), ['historical', 'local@g2']);
  for (const entry of identity.identities) assert.match(entry.objectId, /^[a-f0-9]{64}$/);
  console.log('Native emitted identity route derives actual local IDs without obtaining stubs.');
  const seeded = await mf.dispatchFetch('http://local/seed');
  assert.equal(seeded.status, 200, await seeded.clone().text());
  const deadline = Date.now() + 10000;
  let last = await observe(mf);
  while ((last.schedules.length || last.alarm !== null) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250)); last = await observe(mf);
  }
  assert.equal(last.alarm, null, JSON.stringify(last)); assert.deepEqual(last.schedules, []);
  assert.equal(last.status, 'observed-idle', JSON.stringify(last));
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal((await observe(mf)).status, 'observed-idle');
  await mf.dispose(); mf = new Miniflare(options);
  const restarted = await observe(mf);
  assert.equal(restarted.alarm, null); assert.deepEqual(restarted.schedules, []);
  assert.equal(restarted.status, 'observed-idle', JSON.stringify(restarted));
  console.log('Native SDK physical alarm cleared naturally, stayed idle, and remained idle after reconstruction. No model/delivery/interrupted-attempt proof.');
} finally { await mf.dispose(); await rm(temporary, { recursive: true, force: true }); }
