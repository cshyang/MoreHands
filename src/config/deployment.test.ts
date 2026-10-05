import { withIngressBudget, remainingIngressBudget } from '../slack/ingress-budget';
// Deployment config resolution — run: npx tsx src/config/deployment.test.ts
// Load-bearing: absent env MUST reproduce the original literals (an existing deployment is
// unchanged), and env MUST override them (a new account relocates without a code edit).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  const evaluate = (mode: string | undefined) => {
    const exported: Record<string, any> = {};
    let customize: (config: any) => void = () => { throw new Error('customizer missing'); };
    let pluginCreated = false;
    runInNewContext(ts.transpileModule(read('vite.config.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
      exports: exported, process: { env: { MOREHANDS_BUILD_CUTOVER: mode } },
      require: (name: string) => {
        if (name === 'vite') return { defineConfig: (config: any) => typeof config === 'function' ? config() : config };
        if (name === '@flue/vite') return { flue: () => { pluginCreated = true; return {}; }, flueWorkerConfig: () => {
          assert.equal(pluginCreated, true, 'create flue plugin before customizer');
          return (config: any) => { config.name = 'hatchery'; };
        } };
        if (name === '@cloudflare/vite-plugin') return { cloudflare: (options: any) => { customize = options.config; return {}; } };
        throw new Error('unexpected import');
      },
    });
    const config: any = { vars: { existing: 'retained' } }; customize(config); return config;
  };
  assert.equal(evaluate(undefined).vars.CUTOVER_CONTROL, undefined);
  const fenced = evaluate('fenced');
  assert.equal(fenced.name, 'hatchery'); assert.equal(fenced.vars.existing, 'retained');
  assert.equal(fenced.vars.CUTOVER_CONTROL, 'd1');
  assert.equal(fenced.vars.CUTOVER_NAMESPACE_ID, '1d642bbe6aff4936be41d7cccac2dd5c');
  assert.throws(() => evaluate('invalid'), /Invalid cutover build mode/);
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

test('main CI retains the production fence and avoids a container rollout', async () => {
  const workflow = readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const build = workflow.split('- name: Build (Flue → Cloudflare)')[1]?.split('- name: Deploy hatchery')[0];
  assert.ok(build, 'production build step exists');
  assert.match(build, /MOREHANDS_BUILD_CUTOVER: fenced/);
  assert.match(build, /npm run build[\s\S]*check-cutover-config\.ts --mode fenced --runtime 2\.2\.2 --config dist\/hatchery\/wrangler\.json/);
  assert.match(workflow, /wrangler deploy --config dist\/hatchery\/wrangler\.json --keep-vars --containers-rollout=none/);
});

test('CI migration guard stops on pending migrations and failed remote observations', async () => {
  const workflow = readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const step = workflow.split('- name: Guard against unapplied D1 migrations')[1]?.split('\n      #')[0];
  assert.ok(step, 'migration guard step exists');
  const script = step.split('run: |\n')[1].split('\n').map((line) => line.replace(/^          /, '')).join('\n');
  for (const [exitCode, output, allowed] of [
    [0, 'No migrations to apply!', true],
    [0, '0033_slack_ingress.sql', false],
    [1, 'Remote authentication failed', false],
  ] as const) {
    // Execute the actual workflow guard; only Wrangler is replaced with a fixed response.
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c',
      `npx() { printf '%s\\n' '${output}'; return ${exitCode}; }\n${script}`], { encoding: 'utf8' });
    assert.equal(result.status === 0, allowed, output);
  }
});

test('runner CI deploys with the SDK-compatible locked CLI', async () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json')).packages;
  const version = lock['node_modules/@trigger.dev/sdk'].version;
  assert.equal(lock['node_modules/trigger.dev'].version, version);
  assert.equal(lock['node_modules/@trigger.dev/build'].version, version);
  assert.equal(pkg.scripts['trigger:deploy'], 'trigger deploy');
  const workflow = read('.github/workflows/deploy-runner.yml');
  assert.match(workflow, /run: npm run trigger:deploy/);
  assert.doesNotMatch(workflow, /trigger\.dev@latest/);
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
      if (name === './slack/ingress-budget') return { withIngressBudget, remainingIngressBudget };
      if (name === './app') return { __esModule: true, default: { fetch: async (request: Request) => {
        requests.push(request);
        return new Response('ok');
      } } };
      if (name === './gateway/reminders-store') return { takeDueReminders: async () => {
        scans++;
        return [{ fireId: 'reminder-1' }];
      } };
      if (name === './cutover/admissions') return { beginIntake: async () => null };
      if (name === './cutover/producer') return { createProducerScope: () => ({ finish: async () => {} }) };
      if (name === './gateway/scheduled-dispatch') return { handleScheduledJob: async (env: unknown, body: unknown) => {
        assert.deepEqual(body, { fireId: 'reminder-1' });
        return { status: 200, body: { dispatched: true } };
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
    await exported.default.scheduled({ cron, scheduledTime: 0 }, env, ctx);
  }
  await Promise.all(jobs);
  assert.equal(scans, 1);
  assert.equal(jobs.length, 3);
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname).sort(), [
    '/__internal/agent-runs/reconcile', '/__internal/reflect-sweep',
    '/__internal/replies/reconcile', '/__internal/review-sweep', '/__internal/slack-ingress/reconcile',
  ]);
  for (const request of requests) assert.equal(request.headers.get('x-morehands-token'), 'test-token');
});

run();
