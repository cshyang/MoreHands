import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTestRunner } from '../shared/test-utils';
import { idleFixture } from './evidence-test-fixture';
const { test, run } = createTestRunner();
const root = new URL('../../', import.meta.url);
for (const [name, exit, mutate] of [
  ['qualified idle', 0, () => {}],
  ['blocked', 2, (f: ReturnType<typeof idleFixture>) => { f.producerCount = 1; }],
  ['unknown', 2, (f: ReturnType<typeof idleFixture>) => { f.preBridgeRetirementEvidence = null; }],
  ['invalid', 1, (f: ReturnType<typeof idleFixture>) => { f.producerCount = -1; }],
] as const) test(`offline CLI reports ${name} without network access`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutover-report-test-'));
  try {
    const f = idleFixture(); mutate(f);
    const input = join(dir, 'TEST-DATA.json'); writeFileSync(input, JSON.stringify(f));
    const deny = join(dir, 'deny-network.cjs');
    writeFileSync(deny, `globalThis.fetch=()=>{throw new Error('network forbidden')};
      for(const name of ['http','https','net','tls']) {
        const mod=require('node:'+name);
        for(const key of ['request','get','connect','createConnection']) if(mod[key]) mod[key]=()=>{throw new Error('network forbidden')};
      }`);
    const result = spawnSync(process.execPath, ['--require', deny, 'node_modules/tsx/dist/cli.mjs', 'scripts/cutover-report.ts', '--input', input], {
      cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH },
    });
    assert.equal(result.status, exit, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.ok(report.limitations.includes('observed-idle is not deployment or rollback authorization'));
    if (exit === 1) assert.equal(report.error, 'invalid evidence');
    else assert.equal(report.status, name === 'qualified idle' ? 'observed-idle' : name);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('offline CLI requires an explicit local file, not a URL or default', () => {
  for (const args of [[], ['--input', 'https://fixture.example/evidence'], ['--input', '/missing-TEST-DATA'], ['--input', 'file', '--deploy']]) {
    const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/cutover-report.ts', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.ok(JSON.parse(result.stdout).limitations.length);
  }
});
await run();
