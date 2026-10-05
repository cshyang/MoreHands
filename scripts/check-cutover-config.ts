import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const namespaceId = '1d642bbe6aff4936be41d7cccac2dd5c';
const migrations = [
  { tag: 'flue-class-FlueRegistry', new_sqlite_classes: ['FlueRegistry'] },
  { tag: 'flue-class-Project', new_sqlite_classes: ['Project'] },
  { tag: 'sandbox-class', new_sqlite_classes: ['Sandbox'] },
  { tag: 'flue-011', deleted_classes: ['Project'], new_sqlite_classes: ['FlueProjectAgent'] },
];
try {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== '--mode' || args[2] !== '--runtime' || args[4] !== '--config') throw new Error();
  const mode = args[1], runtime = args[3];
  if (!['fenced', 'ordinary'].includes(mode) || !['2.2.2', '1.0.0-beta.1'].includes(runtime)) throw new Error();
  const config = JSON.parse(readFileSync(args[5], 'utf8'));
  if (config.name !== 'hatchery' || !isDeepStrictEqual(config.migrations, migrations)) throw new Error();
  const bindings = [
    { name: 'SANDBOX', class_name: 'Sandbox' },
    { name: 'FLUE_PROJECT_AGENT', class_name: 'FlueProjectAgent' },
    // Both runtimes must keep the retired registry binding: its class stays exported
    // and the binding preserves existing SQLite storage across the cutover.
    { name: 'FLUE_REGISTRY', class_name: 'FlueRegistry' },
  ];
  const actual = config.durable_objects?.bindings;
  if (!Array.isArray(actual) || !isDeepStrictEqual([...actual].sort((a, b) => a.name.localeCompare(b.name)), bindings.sort((a, b) => a.name.localeCompare(b.name)))) throw new Error();
  if (mode === 'fenced' && (config.vars?.CUTOVER_CONTROL !== 'd1' || config.vars?.CUTOVER_NAMESPACE_ID !== namespaceId)) throw new Error();
  if (mode === 'ordinary' && config.vars?.CUTOVER_CONTROL !== undefined && config.vars.CUTOVER_CONTROL !== 'd1') throw new Error();
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lockBytes = readFileSync(new URL('../package-lock.json', import.meta.url));
  const lock = JSON.parse(lockBytes.toString());
  const version = (name: string) => lock.packages[`node_modules/${name}`]?.version;
  if (pkg.dependencies['@flue/runtime'] !== runtime || version('@flue/runtime') !== runtime) throw new Error();
  if (runtime === '2.2.2') {
    if (pkg.devDependencies['@flue/vite'] !== '2.2.2' || version('@flue/vite') !== '2.2.2'
      || pkg.dependencies['@earendil-works/pi-ai'] !== '0.87.1' || version('@earendil-works/pi-ai') !== '0.87.1') throw new Error();
    for (const name of ['@flue/sdk', '@flue/cli', 'agents', 'patch-package']) if (pkg.dependencies[name] || pkg.devDependencies[name]) throw new Error();
  } else {
    if (pkg.dependencies['@flue/sdk'] !== runtime || pkg.devDependencies['@flue/cli'] !== runtime
      || version('@flue/sdk') !== runtime || version('@flue/cli') !== runtime || version('agents') !== '0.15.0'
      || pkg.scripts.postinstall !== 'patch-package') throw new Error();
    const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    if (hash(lockBytes) !== '717a27c8b2c418298667f62110eb9f69d8f708f37f0fac65635bf18048ac0f28'
      || hash(readFileSync(new URL('../patches/@flue+runtime+1.0.0-beta.1.patch', import.meta.url))) !== '20725afc730f569e7e153e0bc2acc3d01b8be6392edf6af54e62d56f5676a51a') throw new Error();
  }
  process.stdout.write('configuration verified; this is not deployment authorization\n');
} catch {
  process.stdout.write('configuration rejected\n');
  process.exitCode = 1;
}
