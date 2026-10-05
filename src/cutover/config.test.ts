import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTestRunner } from '../shared/test-utils';
const { test, run } = createTestRunner();
const root = new URL('../../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
for (const runtime of [pkg.dependencies['@flue/runtime']] as Array<'2.2.2' | '1.0.0-beta.1'>) {
  const fixture = JSON.parse(readFileSync(new URL(`./test-data/${runtime === '2.2.2' ? 'native' : 'beta'}-identity.json`, import.meta.url), 'utf8'));
  for (const [name, pass, mutate, mode] of [
    ['valid fence', true, () => {}, 'fenced'],
    ['ordinary absent', true, (c: any) => { c.vars = {}; }, 'ordinary'],
    ['missing control', false, (c: any) => { delete c.vars.CUTOVER_CONTROL; }, 'fenced'],
    ['invalid control', false, (c: any) => { c.vars.CUTOVER_CONTROL = ''; }, 'fenced'],
    ['wrong namespace', false, (c: any) => { c.vars.CUTOVER_NAMESPACE_ID = 'test-wrong'; }, 'fenced'],
    ['missing namespace', false, (c: any) => { delete c.vars.CUTOVER_NAMESPACE_ID; }, 'fenced'],
    ['renamed Worker', false, (c: any) => { c.name = 'different'; }, 'fenced'],
    ['altered binding', false, (c: any) => { c.durable_objects.bindings.find((x: any) => x.name === 'FLUE_PROJECT_AGENT').class_name = 'Other'; }, 'fenced'],
    ['external namespace', false, (c: any) => { c.durable_objects.bindings.find((x: any) => x.name === 'FLUE_PROJECT_AGENT').script_name = 'other'; }, 'fenced'],
    ['new migration', false, (c: any) => { c.migrations.push({ tag: 'delete', deleted_classes: ['FlueProjectAgent'] }); }, 'fenced'],
    ['altered historical tag', false, (c: any) => { c.migrations[0].tag = 'different'; }, 'fenced'],
  ] as const) test(`${runtime} emitted config guard: ${name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'cutover-config-test-'));
    try {
      const config = structuredClone(fixture); config.vars = { CUTOVER_CONTROL: 'd1', CUTOVER_NAMESPACE_ID: '1d642bbe6aff4936be41d7cccac2dd5c' }; mutate(config);
      const path = join(dir, 'TEST-DATA-emitted.json'); writeFileSync(path, JSON.stringify(config));
      const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/check-cutover-config.ts', '--mode', mode, '--runtime', runtime, '--config', path], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, pass ? 0 : 1, result.stderr);
      assert.match(result.stdout, pass ? /configuration verified/ : /configuration rejected/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
for (const mutation of ['dependency regression', 'patch removal']) test(`artifact guard rejects ${mutation}`, () => {
  if (mutation === 'patch removal' && pkg.dependencies['@flue/runtime'] !== '1.0.0-beta.1') return;
  const dir = mkdtempSync(join(tmpdir(), 'cutover-dependencies-test-'));
  try {
    const runtime = pkg.dependencies['@flue/runtime'];
    const script = join(dir, 'scripts');
    // Copy only the guard and its local inputs: no credentials, network or production artifact.
    mkdirSync(script); writeFileSync(join(script, 'check-cutover-config.ts'), readFileSync(new URL('scripts/check-cutover-config.ts', root)));
    const copy = structuredClone(pkg);
    if (mutation === 'dependency regression') copy.dependencies['@flue/runtime'] = '0.11.0';
    writeFileSync(join(dir, 'package.json'), JSON.stringify(copy));
    writeFileSync(join(dir, 'package-lock.json'), readFileSync(new URL('package-lock.json', root)));
    const config = JSON.parse(readFileSync(new URL(`./test-data/${runtime === '2.2.2' ? 'native' : 'beta'}-identity.json`, import.meta.url), 'utf8'));
    config.vars = { CUTOVER_CONTROL: 'd1', CUTOVER_NAMESPACE_ID: '1d642bbe6aff4936be41d7cccac2dd5c' };
    const path = join(dir, 'TEST-DATA.json'); writeFileSync(path, JSON.stringify(config));
    const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', join(script, 'check-cutover-config.ts'), '--mode', 'fenced', '--runtime', runtime, '--config', path], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stdout, /configuration rejected/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
await run();
