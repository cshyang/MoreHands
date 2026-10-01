// Deployment config resolution — run: npx tsx src/config/deployment.test.ts
// Load-bearing: absent env MUST reproduce the original literals (an existing deployment is
// unchanged), and env MUST override them (a new account relocates without a code edit).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createTestRunner } from '../shared/test-utils';
import { deploymentConfig, isKnownTeam } from './deployment';

const { test, run } = createTestRunner();

test('falls back to the original literals when env is empty', async () => {
  const cfg = deploymentConfig({});
  assert.deepEqual(cfg.knownTeamIds, ['T0B6VB415TQ']);
  assert.equal(cfg.slackBotId, 'U0B6UB2E5HT');
  assert.equal(cfg.slackTokenRef, 'SLACK_BOT_TOKEN_DEFAULT');
});

test('env overrides every account-coupled value', async () => {
  const cfg = deploymentConfig({
    KNOWN_TEAM_IDS: ' T_NEW , T_TWO ',
    SLACK_BOT_ID: 'U_NEW',
    SLACK_DEFAULT_TOKEN_REF: 'SLACK_BOT_TOKEN_ACME',
  });
  assert.deepEqual(cfg.knownTeamIds, ['T_NEW', 'T_TWO']);
  assert.equal(cfg.slackBotId, 'U_NEW');
  assert.equal(cfg.slackTokenRef, 'SLACK_BOT_TOKEN_ACME');
});

test('blank / whitespace env values fall back, never produce empty config', async () => {
  const cfg = deploymentConfig({ KNOWN_TEAM_IDS: '  ', SLACK_BOT_ID: '', SLACK_DEFAULT_TOKEN_REF: '   ' });
  assert.deepEqual(cfg.knownTeamIds, ['T0B6VB415TQ']);
  assert.equal(cfg.slackBotId, 'U0B6UB2E5HT');
  assert.equal(cfg.slackTokenRef, 'SLACK_BOT_TOKEN_DEFAULT');
});

test('isKnownTeam gates on the env-resolved allowlist', async () => {
  assert.equal(isKnownTeam({}, 'T0B6VB415TQ'), true); // default workspace
  assert.equal(isKnownTeam({}, 'T_SOME_OTHER_WORKSPACE'), false);
  assert.equal(isKnownTeam({}, ''), false);
  assert.equal(isKnownTeam({ KNOWN_TEAM_IDS: 'T_NEW' }, 'T_NEW'), true); // relocated workspace
  assert.equal(isKnownTeam({ KNOWN_TEAM_IDS: 'T_NEW' }, 'T0B6VB415TQ'), false); // old id no longer allowed
});

test('native Vite build and every deploy entry use the generated worker config', async () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.build, 'vite build');
  assert.equal(pkg.scripts.deploy, 'wrangler deploy --config dist/hatchery/wrangler.json');
  assert.equal(pkg.dependencies['@flue/runtime'], '2.2.2');
  assert.equal(pkg.dependencies['@earendil-works/pi-ai'], '0.87.1');
  assert.equal(pkg.devDependencies['@flue/vite'], '2.2.2');
  for (const dependency of ['@flue/sdk', '@flue/cli', 'agents', 'patch-package']) {
    assert.equal(pkg.dependencies[dependency] ?? pkg.devDependencies[dependency], undefined);
  }
  assert.equal(pkg.scripts.postinstall, undefined);
  assert.match(read('vite.config.ts'), /plugins: \[flue\(\), cloudflare\(\{ config: flueWorkerConfig\(\) \}\)\]/);
  for (const path of ['.github/workflows/deploy.yml', 'scripts/setup.sh']) {
    const source = read(path);
    assert.match(source, /npm run build/);
    assert.doesNotMatch(source, /flue build/);
    assert.match(source, /dist\/(?:hatchery|\$WORKER)\/wrangler\.json/);
  }
});

test('setup ships the default Z.ai key and keeps OpenRouter optional', async () => {
  const source = readFileSync(new URL('../../scripts/setup.sh', import.meta.url), 'utf8');
  assert.match(source, /const keys=\["ZAI_API_KEY","ZAI_CODING_API_KEY","OPENROUTER_API_KEY"/);
  assert.match(source, /if \[ -n "\$\{ZAI_API_KEY:-\}" \] \|\| \[ -n "\$\{ZAI_CODING_API_KEY:-\}" \]/);
  assert.doesNotMatch(source, /for k in OPENROUTER_API_KEY/);
  assert.match(source, /OPENROUTER_API_KEY missing — needed only for the Pi runner or OpenRouter model pins/);
  const config = readFileSync(new URL('../../flue.config.ts', import.meta.url), 'utf8');
  assert.match(config, /providers: \['zai', 'openrouter'\]/);
});

test('Flue cutover preserves Durable Object history without a delete/recreate migration', async () => {
  const source = readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8');
  for (const migration of [
    '{ "tag": "flue-class-FlueRegistry", "new_sqlite_classes": ["FlueRegistry"] }',
    '{ "tag": "flue-class-Project", "new_sqlite_classes": ["Project"] }',
    '{ "tag": "sandbox-class", "new_sqlite_classes": ["Sandbox"] }',
    '{ "tag": "flue-011", "deleted_classes": ["Project"], "new_sqlite_classes": ["FlueProjectAgent"] }',
  ]) assert.ok(source.includes(migration));
  assert.doesNotMatch(source, /"deleted_classes":\s*\[[^\]]*"Flue(?:ProjectAgent|Registry)"/);
});

test('product crons retain authentication but never dispatch generic heartbeat', async () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const worker = read('src/cloudflare.ts');
  const config = read('wrangler.jsonc');
  assert.doesNotMatch(config, /0 \*\/6 \* \* \*/);
  assert.doesNotMatch(worker, /HEARTBEAT_CRON|\/__heartbeat/);
  assert.match(worker, /if \(!env\.HEARTBEAT_TOKEN\) return;/);
  assert.match(worker, /'x-morehands-token': env\.HEARTBEAT_TOKEN/);
  assert.match(worker, /default:\s*return;/);
  for (const cron of ['0 19 * * *', '*/2 * * * *', '* * * * *']) {
    assert.ok(config.includes(`"${cron}"`));
    assert.ok(worker.includes(`'${cron}'`));
  }
});

test('scheduled wrapper only runs known authenticated product tasks', async () => {
  // Compile just the wrapper and stub Worker-only imports, so no model, Slack, or
  // Cloudflare runtime is needed to exercise the real scheduling dispatch.
  const source = readFileSync(new URL('../cloudflare.ts', import.meta.url), 'utf8');
  const requests: Request[] = [];
  let scans = 0;
  const exported: Record<string, any> = {};
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(output, {
    exports: exported,
    require: (name: string) => {
      if (name === './app') return { __esModule: true, default: { fetch: async (request: Request) => {
        requests.push(request);
        return new Response('ok');
      } } };
      if (name === './gateway/reminders-store') return { takeDueReminders: async () => {
        scans++;
        return [{ fireId: 'reminder-1' }];
      } };
      if (name === '@cloudflare/sandbox') return { Sandbox: class {} };
      if (name === 'cloudflare:workers') return { DurableObject: class {} };
      throw new Error(`Unexpected import ${name}`);
    },
    Request,
    Response,
    console: { log() {} },
  });
  const retired = await new exported.FlueRegistry().fetch();
  assert.equal(retired.status, 404);
  assert.equal(await retired.text(), 'Registry retired');
  const jobs: Promise<unknown>[] = [];
  const ctx = { waitUntil: (job: Promise<unknown>) => jobs.push(job) };
  const env = { HEARTBEAT_TOKEN: 'test-token', DB: {} };
  await exported.default.scheduled({ cron: '0 */6 * * *' }, env, ctx);
  await exported.default.scheduled({ cron: 'unexpected' }, env, ctx);
  await exported.default.scheduled({}, env, ctx);
  await exported.default.scheduled({ cron: exported.REMINDERS_CRON }, { DB: {} }, ctx);
  assert.equal(jobs.length, 0);
  assert.equal(scans, 0);
  assert.equal(requests.length, 0);
  for (const cron of [exported.REMINDERS_CRON, exported.RECONCILE_CRON, exported.REFLECT_CRON]) {
    await exported.default.scheduled({ cron }, env, ctx);
  }
  await Promise.all(jobs);
  assert.equal(scans, 1);
  assert.equal(jobs.length, 3);
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname).sort(), [
    '/__internal/agent-runs/reconcile', '/__internal/reflect-sweep',
    '/__internal/replies/reconcile', '/__internal/review-sweep', '/__internal/scheduled',
  ]);
  for (const request of requests) assert.equal(request.headers.get('x-morehands-token'), 'test-token');
});

run();
