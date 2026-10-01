// Slack-first setup status invariants — run: npx tsx src/setup/status.test.ts

import assert from 'node:assert/strict';
import { createTestRunner, invokeTool } from '../shared/test-utils';
import type { Binding } from '../project/bindings';
import type { D1Like } from '../skills/repository';
import { buildSetupStatus, setupStatusTool } from './status';

const { test, run } = createTestRunner();

type Row = Record<string, unknown>;

class FakeD1 implements D1Like {
  connections: Row[] = [];
  routes: Row[] = [];

  prepare(sql: string) {
    const db = this;
    const query = sql.trim();
    return {
      bind(...values: unknown[]) {
        return {
          async first<T = Row>(): Promise<T | null> {
            const { results } = await this.all<T>();
            return results[0] ?? null;
          },
          async all<T = Row>(): Promise<{ results: T[] }> {
            if (query.startsWith('SELECT provider, token_ref')) {
              const [projectId] = values;
              return { results: db.connections.filter((r) => r.project_id === projectId) as T[] };
            }
            if (query.includes('FROM agent_run_routes') && query.includes('WHERE project_id=?')) {
              const [projectId] = values;
              return {
                results: db.routes
                  .filter((r) => r.project_id === projectId)
                  .sort((a, b) => Number(b.priority ?? 0) - Number(a.priority ?? 0)) as T[],
              };
            }
            return { results: [] as T[] };
          },
          async run(): Promise<unknown> {
            return {};
          },
        };
      },
    };
  }
}

function binding(): Binding {
  return {
    provider: 'slack',
    externalAccountId: 'T1',
    externalSpaceId: 'C1',
    transportBotId: 'U1',
    projectId: 'project_1',
    sandboxMode: 'virtual',
    transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    status: 'active',
  };
}

function connection(provider: string, config: Record<string, unknown> = {}): Row {
  return {
    project_id: 'project_1',
    provider,
    token_ref: null,
    connection_ref: `conn_${provider}`,
    config_json: JSON.stringify(config),
    status: 'active',
  };
}

function route(status = 'active', runtime = 'pi'): Row {
  return {
    id: 'route_1',
    project_id: 'project_1',
    provider: 'linear',
    external_key: 'EDK',
    trigger_type: 'state',
    trigger_value: 'Run Agent',
    github_owner: 'acme',
    github_repo: 'widgets',
    base_branch: 'main',
    kit: 'coding-default',
    runtime,
    sandbox_provider: 'e2b',
    priority: 10,
    status,
  };
}

test('setup_status reports missing GitHub and Linear for a project with no active connections', async () => {
  const db = new FakeD1();
  const status = await buildSetupStatus({
    db,
    binding: binding(),
    projectId: 'project_1',
    env: {},
    intent: 'run_agent',
  });

  assert.equal(status.ready, false);
  assert.ok(status.missing.some((m) => m.provider === 'github'));
  assert.ok(status.missing.some((m) => m.provider === 'linear'));
  assert.equal(status.nextAction?.type, 'request_connection');
  assert.equal(status.nextAction?.provider, 'github');
  assert.match(status.slackText, /Run Agent setup/);
  assert.match(status.slackText, /GitHub/);
  assert.match(status.slackText, /Linear/);
  assert.doesNotMatch(JSON.stringify(status), /SECRET|TOKEN|NANGO/i);
});

test('setup_status reports GitHub PAT repo metadata when connected through github-pat', async () => {
  const db = new FakeD1();
  db.connections.push(connection('github', { authMode: 'pat', repo: 'acme/widgets', nangoIntegrationKey: 'github-pat' }));

  const status = await buildSetupStatus({
    db,
    binding: binding(),
    projectId: 'project_1',
    env: { NANGO_SECRET_KEY: 'secret' },
    targetRepo: 'acme/widgets',
  });

  assert.deepEqual(status.connected.find((c) => c.provider === 'github'), {
    provider: 'github',
    authMode: 'pat',
    repo: 'acme/widgets',
  });
});

test('setup_status reports missing Linear route when GitHub and Linear are connected', async () => {
  const db = new FakeD1();
  db.connections.push(connection('github', { authMode: 'oauth' }), connection('linear', { authMode: 'oauth' }));

  const status = await buildSetupStatus({
    db,
    binding: binding(),
    projectId: 'project_1',
    env: { NANGO_SECRET_KEY: 'secret', TRIGGER_SECRET_KEY: 'trigger_secret', AGENT_RUNNER_TOKEN: 'runner_secret', RUNNER_GITHUB_PAT_TEMP: 'github_secret', MOREHANDS_PUBLIC_URL: 'https://hatchery.example' },
    targetRepo: 'acme/widgets',
    linearTeamKey: 'EDK',
  });

  assert.equal(status.ready, false);
  assert.ok(status.missing.some((m) => m.kind === 'route' && m.provider === 'linear'));
  assert.equal(status.nextAction?.type, 'activate_route');
  assert.doesNotMatch(JSON.stringify(status), /runner_secret|trigger_secret|github_secret|https:\/\/hatchery\.example|AGENT_RUNNER_TOKEN|TRIGGER_SECRET_KEY|RUNNER_GITHUB_PAT_TEMP|MOREHANDS_PUBLIC_URL|NANGO_SECRET_KEY/);
});

test('setup_status reports ready when GitHub, Linear, active route, and runner config are present', async () => {
  const db = new FakeD1();
  db.connections.push(connection('github', { authMode: 'pat', repo: 'acme/widgets' }), connection('linear', { authMode: 'oauth' }));
  db.routes.push(route('active'));

  const status = await buildSetupStatus({
    db,
    binding: binding(),
    projectId: 'project_1',
    env: { NANGO_SECRET_KEY: 'secret', TRIGGER_SECRET_KEY: 'trigger_secret', AGENT_RUNNER_TOKEN: 'runner_secret', RUNNER_GITHUB_PAT_TEMP: 'github_secret', MOREHANDS_PUBLIC_URL: 'https://hatchery.example' },
    targetRepo: 'acme/widgets',
    linearTeamKey: 'EDK',
    intent: 'run_agent',
  });

  assert.equal(status.ready, true);
  assert.deepEqual(status.missing, []);
  assert.equal(status.routes[0].status, 'active');
  assert.equal(status.routes[0].targetRepo, 'acme/widgets');
  assert.deepEqual(status.runner, { configured: true, runtime: 'pi', sandboxProvider: 'e2b' });
  assert.equal(status.nextAction?.type, 'none');
  assert.match(status.slackText, /Ready/);
  assert.match(status.slackText, /acme\/widgets/);
});

test('setup_status reports the runner configured via a GitHub connection with no PAT fallback', async () => {
  const db = new FakeD1();
  db.connections.push(connection('github', { authMode: 'oauth' }), connection('linear', { authMode: 'oauth' }));
  db.routes.push(route('active'));

  const status = await buildSetupStatus({
    db,
    binding: binding(),
    projectId: 'project_1',
    // No RUNNER_GITHUB_PAT_TEMP — the App installation token from the github connection is the write credential.
    env: { NANGO_SECRET_KEY: 'secret', TRIGGER_SECRET_KEY: 'trigger_secret', AGENT_RUNNER_TOKEN: 'runner_secret', MOREHANDS_PUBLIC_URL: 'https://hatchery.example' },
    linearTeamKey: 'EDK',
    intent: 'run_agent',
  });

  assert.equal(status.runner.configured, true, 'github connection satisfies the write-credential leg without the PAT');
});

test('setup_status flags legacy opencode active routes before Pi readiness', async () => {
  const db = new FakeD1();
  db.connections.push(connection('github', { authMode: 'pat', repo: 'acme/widgets' }), connection('linear', { authMode: 'oauth' }));
  db.routes.push(route('active', 'opencode'));

  const status = await buildSetupStatus({
    db,
    binding: binding(),
    projectId: 'project_1',
    env: { NANGO_SECRET_KEY: 'secret', TRIGGER_SECRET_KEY: 'trigger_secret', AGENT_RUNNER_TOKEN: 'runner_secret', RUNNER_GITHUB_PAT_TEMP: 'github_secret', MOREHANDS_PUBLIC_URL: 'https://hatchery.example' },
    targetRepo: 'acme/widgets',
    linearTeamKey: 'EDK',
  });

  assert.equal(status.ready, false);
  assert.equal(status.runner.runtime, 'pi');
  assert.ok(status.missing.some((m) => m.kind === 'route' && /legacy runtime "opencode"/.test(m.reason)));
  assert.equal(status.routes[0].runtime, 'opencode');
  assert.equal(status.nextAction?.type, 'activate_route');
});

test('setup_status tool returns structured JSON without exposing configured values', async () => {
  const db = new FakeD1();
  db.connections.push(connection('github', { authMode: 'pat', repo: 'acme/widgets' }), connection('linear', { authMode: 'oauth' }));
  db.routes.push(route('active'));
  const tool = setupStatusTool({
    db,
    binding: binding(),
    projectId: 'project_1',
    env: { NANGO_SECRET_KEY: 'secret', TRIGGER_SECRET_KEY: 'trigger_secret', AGENT_RUNNER_TOKEN: 'runner_secret', RUNNER_GITHUB_PAT_TEMP: 'github_secret', MOREHANDS_PUBLIC_URL: 'https://hatchery.example' },
  });

  const out = await invokeTool(tool, {
    targetRepo: 'acme/widgets',
    linearTeamKey: 'EDK',
    intent: 'run_agent',
  });
  const parsed = JSON.parse(out) as { ready: boolean; connected: unknown[]; nextAction: { type: string }; slackText: string };

  assert.equal(parsed.ready, true);
  assert.equal(parsed.nextAction.type, 'none');
  assert.equal(parsed.connected.length, 2);
  assert.match(parsed.slackText, /Run Agent setup/);
  assert.doesNotMatch(out, /runner_secret|trigger_secret|github_secret|https:\/\/hatchery\.example|NANGO_SECRET_KEY|AGENT_RUNNER_TOKEN|TRIGGER_SECRET_KEY|RUNNER_GITHUB_PAT_TEMP|MOREHANDS_PUBLIC_URL/);
});

test('setup_status surfaces the slash commands and the operator doctor check', async () => {
  const db = new FakeD1();
  const status = await buildSetupStatus({
    db,
    binding: binding(),
    projectId: 'project_1',
    env: {},
    intent: 'run_agent',
  });

  assert.ok(status.tips.some((t) => t.includes('/hands')), 'tips should mention the /hands slash command');
  assert.ok(status.tips.some((t) => t.includes('setup.sh doctor')), 'tips should mention the doctor check');
  assert.match(status.slackText, /\/hands/);
  assert.match(status.slackText, /setup\.sh doctor/);
  // The runner gap points operators at doctor, which shows exactly what is missing.
  const runnerGap = status.missing.find((m) => m.kind === 'runner');
  assert.ok(runnerGap && /setup\.sh doctor/.test(runnerGap.nextAction));
});

await run();
