// Connection broker invariants (ADR 0003) — run: npx tsx src/connections/connections.test.ts
// Backend = Worker-secret refs (like the Slack token). The state/resolve/tool functions operate on
// ConnectionSpec[]; the initializer resolves those from D1 (live) merged over the binding seed via
// loadConnectionSpecs. Load-bearing invariants: gating (tools appear only when connected, never the
// write), the secret-name is never the value, generic-vs-typed selection, per-provider method policy,
// and the D1 metadata layer (operator add without redeploy).

import assert from 'node:assert/strict';
import * as v from 'valibot';
import { createTestRunner, invokeTool } from '../shared/test-utils';
import {
  connectionState,
  resolveConnection,
  resolveProviderToken,
  loadConnections,
  loadConnectionSpecs,
  upsertConnection,
  connectedNotice,
  disconnectedNotice,
  disableConnectionByRef,
} from './repository';
import { connectionTools, connectionsBlock, requestConnectionTool, disconnectConnectionTool } from './tools';
import { dynamicApiProfile, nangoProxyProfile, effectiveMethodPolicy, genericApiTool } from '../providers/generic-api';
import { buildConnectionRuntime } from './runtime';
import { PROVIDER_CATALOG } from './catalog';
import { nangoIntegrationKey, normalizeAuthMode, supportedAuthModes } from './integrations';
import { GITHUB_READ_TOOL_NAMES } from '../providers/github';
import type { D1Like } from '../skills/repository';
import type { Binding, ConnectionSpec } from '../project/bindings';

const GITHUB_CALL_API_TOOL_NAME = 'github_call_api';
const NOTION_CALL_API_TOOL_NAME = 'notion_call_api';

// A minimal binding carrying a connections seed (used by the loadConnectionSpecs tests).
function binding(connections?: ConnectionSpec[]): Binding {
  return {
    provider: 'slack',
    externalAccountId: 'T',
    externalSpaceId: 'C',
    transportBotId: 'U',
    projectId: 'demo',
    sandboxMode: 'virtual',
    transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    connections,
    status: 'active',
  };
}

const GH: ConnectionSpec[] = [{ provider: 'github', tokenRef: 'GITHUB_PAT_DEMO', config: { repo: 'o/r' } }];
const NANGO_REF: ConnectionSpec[] = [{ provider: 'notion', connectionRef: 'conn_42', config: {} }];
const NANGO_GITHUB_PAT: ConnectionSpec[] = [
  { provider: 'github', connectionRef: 'conn_gh_pat', config: { nangoIntegrationKey: 'github-pat', authMode: 'pat', repo: 'acme/repo' } },
];

// In-memory D1 fake — only the two statements repository.ts issues (coupled on purpose).
interface Row {
  [k: string]: unknown;
}
class FakeD1 implements D1Like {
  rows: Row[] = [];
  prepare(sql: string) {
    const t = sql.trim();
    return {
      bind: (...args: unknown[]) => ({
        run: async (): Promise<unknown> => {
          this.#mutate(t, args);
          return {};
        },
        all: async <T = Record<string, unknown>>(): Promise<{ results: T[] }> => ({ results: this.#query(t, args) as T[] }),
        first: async <T = Record<string, unknown>>(): Promise<T | null> => (this.#query(t, args)[0] ?? null) as T | null,
      }),
    };
  }
  #mutate(sql: string, args: unknown[]) {
    if (sql.startsWith('INSERT INTO connections')) {
      const [projectId, provider, tokenRef, connectionRef, configJson, status, createdBy, createdAt, updatedAt] = args;
      const existing = this.rows.find((r) => r.project_id === projectId && r.provider === provider);
      const next = {
        project_id: projectId,
        provider,
        token_ref: tokenRef,
        connection_ref: connectionRef,
        config_json: configJson,
        status,
        created_by: createdBy,
        created_at: createdAt,
        updated_at: updatedAt,
      };
      if (existing) Object.assign(existing, { token_ref: tokenRef, connection_ref: connectionRef, config_json: configJson, status, updated_at: updatedAt });
      else this.rows.push(next);
    }
  }
  #query(sql: string, args: unknown[]): Row[] {
    if (sql.startsWith('SELECT provider, token_ref')) {
      const [projectId] = args;
      return this.rows.filter((r) => r.project_id === projectId);
    }
    return [];
  }
}

const { test, run } = createTestRunner();

test('not connected: a declared spec with no secret present reads as not_connected', async () => {
  const state = connectionState(GH, {});
  assert.equal(state.length, 1);
  assert.equal(state[0].status, 'not_connected');
  assert.equal(resolveConnection(GH, {}, 'github'), null);
});

test('connected: state flips when the Worker secret is present; resolve returns the token + config', async () => {
  const env = { GITHUB_PAT_DEMO: 'ghp_realtoken' };
  const state = connectionState(GH, env);
  assert.equal(state[0].status, 'connected');
  const resolved = resolveConnection(GH, env, 'github');
  assert.equal(resolved?.secret, 'ghp_realtoken');
  assert.equal(resolved?.config.repo, 'o/r');
});

test('no declared connection → nothing, even if a stray secret exists in env', async () => {
  assert.equal(connectionState([], { GITHUB_PAT_DEMO: 'ghp_x' }).length, 0);
  assert.equal(resolveConnection([], { GITHUB_PAT_DEMO: 'ghp_x' }, 'github'), null);
});

test('connectionRef + NANGO_SECRET_KEY present → connected (managed-OAuth backend)', async () => {
  assert.equal(connectionState(NANGO_REF, {}).length, 1);
  assert.equal(connectionState(NANGO_REF, {})[0].status, 'not_connected', 'no platform key → cannot fetch → not connected');
  assert.equal(connectionState(NANGO_REF, { NANGO_SECRET_KEY: 'nk_secret' })[0].status, 'connected');
});

test('a Worker-secret connection still drives state independently of NANGO_SECRET_KEY', async () => {
  // tokenRef path is unaffected by the Nango branch.
  assert.equal(connectionState(GH, { NANGO_SECRET_KEY: 'nk_secret' })[0].status, 'not_connected');
  assert.equal(connectionState(GH, { GITHUB_PAT_DEMO: 'ghp_x' })[0].status, 'connected');
});

test('gating: GitHub typed read tools appear only when connected, and the write is NOT exposed', async () => {
  assert.equal(connectionTools(connectionState(GH, {}), {}).length, 0, 'no tools before the secret is set');
  const env = { GITHUB_PAT_DEMO: 'ghp_realtoken' };
  const creds = resolveConnection(GH, env, 'github')!;
  const names = connectionTools(connectionState(GH, env), { github: creds }).map((t) => t.name as string).sort();
  assert.ok(!names.includes('github_create_issue'), 'write tool must NOT be exposed');
  assert.deepEqual(names, [...GITHUB_READ_TOOL_NAMES].sort(), 'exactly the typed read tools');
});

test('apiMode "generic" exposes ONLY github_call_api, not the typed reads', async () => {
  const GEN: ConnectionSpec[] = [{ provider: 'github', tokenRef: 'GITHUB_PAT_DEMO', config: { repo: 'o/r', apiMode: 'generic' } }];
  const env = { GITHUB_PAT_DEMO: 'ghp_realtoken' };
  const creds = resolveConnection(GEN, env, 'github')!;
  const names = connectionTools(connectionState(GEN, env), { github: creds }).map((t) => t.name as string);
  assert.deepEqual(names, [GITHUB_CALL_API_TOOL_NAME], 'generic mode = exactly the one call tool');
  for (const typed of GITHUB_READ_TOOL_NAMES) assert.ok(!names.includes(typed), `${typed} must be hidden in generic mode`);
});

test('github_call_api refuses non-GET (writes go through the approval gate, not a blind call)', async () => {
  const GEN: ConnectionSpec[] = [{ provider: 'github', tokenRef: 'GITHUB_PAT_DEMO', config: { repo: 'o/r', apiMode: 'generic' } }];
  const env = { GITHUB_PAT_DEMO: 'ghp_realtoken' };
  const creds = resolveConnection(GEN, env, 'github')!;
  const [callApi] = connectionTools(connectionState(GEN, env), { github: creds });
  await assert.rejects(
    () => invokeTool(callApi, { method: 'POST', path: '/repos/o/r/issues' }),
    /Only GET is allowed/,
  );
});

test('notion defaults to the generic call_api tool (no typed tools), gated on its secret', async () => {
  const NO: ConnectionSpec[] = [{ provider: 'notion', tokenRef: 'NOTION_TOKEN_DEMO', config: {} }];
  assert.equal(connectionTools(connectionState(NO, {}), {}).length, 0, 'no tool before the secret is set');
  const env = { NOTION_TOKEN_DEMO: 'secret_ntn' };
  const creds = resolveConnection(NO, env, 'notion')!;
  const names = connectionTools(connectionState(NO, env), { notion: creds }).map((t) => t.name as string);
  assert.deepEqual(names, [NOTION_CALL_API_TOOL_NAME], 'notion = exactly the one generic call tool');
});

test('notion_call_api allows POST (reads use POST; token is read-only at the provider)', async () => {
  const NO: ConnectionSpec[] = [{ provider: 'notion', tokenRef: 'NOTION_TOKEN_DEMO', config: {} }];
  const env = { NOTION_TOKEN_DEMO: 'secret_ntn' };
  const creds = resolveConnection(NO, env, 'notion')!;
  const [callApi] = connectionTools(connectionState(NO, env), { notion: creds });
  await assert.doesNotReject(async () => {
    try {
      await invokeTool(callApi, { method: 'POST', path: '/v1/search', body: '{}' });
    } catch (e) {
      if (/Only GET is allowed/.test((e as Error).message)) throw e; // a network/auth error is fine; a method-gate refusal is not
    }
  });
});

test('connectionsBlock shows connected vs not-connected from real state', async () => {
  const connected = connectionsBlock(connectionState(GH, { GITHUB_PAT_DEMO: 'x' }), PROVIDER_CATALOG);
  assert.match(connected, /✅ github \(connected: repo o\/r\)/);
  const notConnected = connectionsBlock(connectionState(GH, {}), PROVIDER_CATALOG);
  assert.match(notConnected, /⚪ github \(not connected\)/);
});

test('buildConnectionRuntime: assembles connected provider tools and prompt block from the binding seed', async () => {
  const seeded = binding([{ provider: 'github', tokenRef: 'GITHUB_PAT_DEMO', config: { repo: 'o/r', apiMode: 'generic' } }]);
  const runtime = await buildConnectionRuntime({ db: undefined, binding: seeded, env: { GITHUB_PAT_DEMO: 'ghp_x' }, projectId: 'demo' });
  assert.deepEqual(runtime.tools.map((t) => t.name), [GITHUB_CALL_API_TOOL_NAME]);
  assert.match(runtime.connectionsBlock ?? '', /✅ github \(connected: repo o\/r\)/);
  assert.doesNotMatch(runtime.connectionsBlock ?? '', /request_connection/);
});

test('buildConnectionRuntime: exposes self-service connection tools when Nango is configured', async () => {
  const runtime = await buildConnectionRuntime({
    db: new FakeD1(),
    binding: binding([]),
    env: { NANGO_SECRET_KEY: 'nk' },
    projectId: 'demo',
    listIntegrationsImpl: async () => [],
  });
  assert.deepEqual(runtime.tools.map((t) => t.name).sort(), ['assign_coding_run', 'check_agent_runs', 'disconnect_connection', 'propose_agent_route', 'request_connection']);
  assert.match(runtime.connectionsBlock ?? '', /request_connection/);
});

test('buildConnectionRuntime: surfaces Nango-enabled integrations as connectable in the prompt block', async () => {
  const runtime = await buildConnectionRuntime({
    db: new FakeD1(),
    binding: binding([]),
    env: { NANGO_SECRET_KEY: 'nk-avail' },
    projectId: 'demo',
    listIntegrationsImpl: async () => [
      { uniqueKey: 'google-mail', provider: 'google-mail', displayName: 'Gmail' },
      { uniqueKey: 'github-app', provider: 'github-app', displayName: 'GitHub App' },
      { uniqueKey: 'github', provider: 'github', displayName: 'GitHub' },
    ],
  });
  const block = runtime.connectionsBlock ?? '';
  // The enabled-but-uncatalogued integration is offered to the agent…
  assert.match(block, /⚪ google-mail \(Gmail\) \(not connected; enabled in Nango\) — request_connection "google-mail" to connect/);
  // …while auth-mode variants and exact matches of curated providers fold into their catalog line.
  assert.doesNotMatch(block, /github-app/);
  assert.equal(block.match(/⚪ github /g)?.length, 1);
});

test('D1 layer: loadConnectionSpecs merges live rows over the binding seed (D1 wins, disabled removes)', async () => {
  const db = new FakeD1();
  const seeded = binding([
    { provider: 'github', tokenRef: 'GH_SEED', config: { repo: 'seed/repo' } },
    { provider: 'notion', tokenRef: 'NOTION_SEED', config: {} },
  ]);

  // No rows yet → specs == seed (demo keeps working with an empty table).
  let specs = await loadConnectionSpecs(db, seeded);
  assert.deepEqual(specs.map((s) => s.provider).sort(), ['github', 'notion']);
  assert.equal(specs.find((s) => s.provider === 'github')!.tokenRef, 'GH_SEED');

  // Operator overrides github live (new tokenRef + config) and adds linear → no redeploy.
  await upsertConnection(db, { projectId: 'demo', provider: 'github', tokenRef: 'GH_LIVE', config: { repo: 'live/repo', apiMode: 'generic' } });
  await upsertConnection(db, { projectId: 'demo', provider: 'linear', tokenRef: 'LINEAR_LIVE', config: {} });
  specs = await loadConnectionSpecs(db, seeded);
  const gh = specs.find((s) => s.provider === 'github')!;
  assert.equal(gh.tokenRef, 'GH_LIVE', 'live D1 row overrides the seed');
  assert.equal(gh.config!.apiMode, 'generic');
  assert.ok(specs.some((s) => s.provider === 'linear'), 'a live-only provider appears with no redeploy');

  // Disabling removes a seeded provider.
  await upsertConnection(db, { projectId: 'demo', provider: 'notion', status: 'disabled' });
  specs = await loadConnectionSpecs(db, seeded);
  assert.ok(!specs.some((s) => s.provider === 'notion'), 'disabled removes the seeded connection');
});

test('D1 layer: loadConnections returns metadata only and never a secret value', async () => {
  const db = new FakeD1();
  await upsertConnection(db, { projectId: 'p', provider: 'github', tokenRef: 'GITHUB_PAT_X', config: { repo: 'a/b' } });
  const rows = await loadConnections(db, 'p');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokenRef, 'GITHUB_PAT_X'); // a NAME, not a token value
  assert.equal(rows[0].config.repo, 'a/b');
  assert.equal(rows[0].status, 'active');
  // the record shape carries no secret/value field at all
  assert.ok(!('secret' in rows[0]) && !('value' in rows[0]));
});

test('connectedNotice: a friendly ✅ confirmation naming the provider (the webhook posts this to the channel)', async () => {
  const msg = connectedNotice('notion');
  assert.match(msg, /✅/);
  assert.match(msg, /notion/i);
});

test('disconnectedNotice: a clear 🔌 disconnect message naming the provider', async () => {
  const msg = disconnectedNotice('notion');
  assert.match(msg, /🔌|disconnect/i);
  assert.match(msg, /notion/i);
});

test('disableConnectionByRef: flips the matching row to disabled and returns {projectId, provider}; null if no row matches', async () => {
  // A focused fake covering exactly the two statements disableConnectionByRef issues: a SELECT by
  // connection_ref and an UPDATE status by connection_ref.
  interface CRow { project_id: string; provider: string; connection_ref: string | null; status: string }
  class RefD1 implements D1Like {
    rows: CRow[];
    constructor(rows: CRow[]) { this.rows = rows; }
    prepare(sql: string) {
      const t = sql.trim();
      return {
        bind: (...args: unknown[]) => ({
          run: async () => { this.#mutate(t, args); return {}; },
          all: async <T = Record<string, unknown>>() => ({ results: this.#query(t, args) as T[] }),
          first: async <T = Record<string, unknown>>() => (this.#query(t, args)[0] ?? null) as T | null,
        }),
      };
    }
    #mutate(sql: string, args: unknown[]) {
      if (sql.startsWith('UPDATE connections SET status=')) {
        const ref = args[args.length - 1]; // WHERE connection_ref=? is the LAST bound param
        const row = this.rows.find((r) => r.connection_ref === ref);
        if (row) row.status = 'disabled';
      }
    }
    #query(sql: string, args: unknown[]): CRow[] {
      if (sql.startsWith('SELECT project_id, provider FROM connections WHERE connection_ref')) {
        const [ref] = args;
        return this.rows.filter((r) => r.connection_ref === ref);
      }
      return [];
    }
  }

  const db = new RefD1([{ project_id: 'C123', provider: 'notion', connection_ref: 'conn_42', status: 'active' }]);
  const hit = await disableConnectionByRef(db, 'conn_42');
  assert.deepEqual(hit, { projectId: 'C123', provider: 'notion' });
  assert.equal(db.rows[0].status, 'disabled', 'row is now disabled (loadConnectionSpecs will drop it → tool disappears)');

  const miss = await disableConnectionByRef(new RefD1([]), 'nope');
  assert.equal(miss, null, 'unknown connection_ref → null (nothing to disable)');
});

test('resolveConnection: tokenRef path still returns a literal string secret', async () => {
  const resolved = resolveConnection(GH, { GITHUB_PAT_DEMO: 'ghp_realtoken' }, 'github');
  assert.equal(typeof resolved?.secret, 'string');
  assert.equal(resolved?.secret, 'ghp_realtoken');
});

test('resolveConnection: connectionRef path returns a LAZY thunk, memoized to ONE fetch per turn', async () => {
  let fetchCount = 0;
  const fakeFetchToken = async () => { fetchCount++; return 'live_at_777'; };
  const resolved = resolveConnection(NANGO_REF, { NANGO_SECRET_KEY: 'nk' }, 'notion', { fetchToken: fakeFetchToken });
  assert.equal(typeof resolved?.secret, 'function', 'Nango credential is a deferred fetch');
  assert.equal(fetchCount, 0, 'building the credential must NOT fetch (initializer stays network-light)');
  const get = resolved!.secret as () => Promise<string>;
  assert.equal(await get(), 'live_at_777');
  assert.equal(await get(), 'live_at_777');
  assert.equal(fetchCount, 1, 'a multi-call turn pays exactly one Nango round-trip (memoized)');
});

test('resolveConnection: Nango connectionRef uses config.nangoIntegrationKey when it differs from provider', async () => {
  const calls: { providerConfigKey: string; connectionId: string }[] = [];
  const fakeFetchToken = async (args: { providerConfigKey: string; connectionId: string }) => {
    calls.push(args);
    return 'live_gh_pat';
  };
  const resolved = resolveConnection(NANGO_GITHUB_PAT, { NANGO_SECRET_KEY: 'nk' }, 'github', { fetchToken: fakeFetchToken });
  const get = resolved!.secret as () => Promise<string>;
  assert.equal(await get(), 'live_gh_pat');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].connectionId, 'conn_gh_pat');
  assert.equal(calls[0].providerConfigKey, 'github-pat');
});

test('resolveConnection: connectionRef but NO platform key → null (no broken tool)', async () => {
  assert.equal(resolveConnection(NANGO_REF, {}, 'notion'), null);
});

// ── resolveProviderToken (one-call convenience: loadConnectionSpecs → resolveConnection → token) ──
// Used by the dispatch path (github) and the Linear reply path: resolve a provider's live token in one
// await, awaiting the Nango thunk when present. Auth-mode-agnostic (oauth/pat/app all return a string).

test('resolveProviderToken: returns a literal Worker-secret token (no db → binding seed)', async () => {
  const token = await resolveProviderToken(undefined, binding(GH), { GITHUB_PAT_DEMO: 'ghp_lit' }, 'github');
  assert.equal(token, 'ghp_lit');
});

test('resolveProviderToken: awaits the Nango thunk and returns the live token', async () => {
  const fakeFetchToken = async () => 'live_at_777';
  const token = await resolveProviderToken(undefined, binding(NANGO_REF), { NANGO_SECRET_KEY: 'nk' }, 'notion', { fetchToken: fakeFetchToken });
  assert.equal(token, 'live_at_777');
});

test('resolveProviderToken: null when the provider is not connected', async () => {
  assert.equal(await resolveProviderToken(undefined, binding([]), {}, 'github'), null);
});

test('a Nango-backed notion connection builds notion_call_api whose run resolves the lazy token', async () => {
  let fetchCount = 0;
  const fakeFetchToken = async () => { fetchCount++; return 'live_notion_at'; };
  const specs: ConnectionSpec[] = [{ provider: 'notion', connectionRef: 'conn_42', config: {} }];
  const env = { NANGO_SECRET_KEY: 'nk' };
  const creds = resolveConnection(specs, env, 'notion', { fetchToken: fakeFetchToken })!;
  const tools = connectionTools(connectionState(specs, env), { notion: creds });
  assert.deepEqual(tools.map((t) => t.name), ['notion_call_api'], 'connected Nango notion exposes the generic call tool');
  assert.equal(fetchCount, 0, 'building the tool must not fetch a token');
  // run resolves the lazy token (a network error after that is fine; a method-gate refusal is not).
  await assert.doesNotReject(async () => {
    try {
      await invokeTool(tools[0], { method: 'POST', path: '/v1/search', body: '{}' });
    } catch (e) {
      if (/Only GET is allowed/.test((e as Error).message)) throw e;
    }
  });
  assert.ok(fetchCount >= 1, 'run resolved the lazy token at least once');
});

test('request_connection: schema has setup metadata but NO secret/token parameter (the structural wall)', async () => {
  const tool = requestConnectionTool({ nangoSecretKey: 'nk', projectId: 'C123' });
  assert.equal(tool.name, 'request_connection');
  const props = (tool.input as v.ObjectSchema<v.ObjectEntries, undefined>).entries;
  const keys = Object.keys(props);
  assert.deepEqual(keys, ['provider', 'authMode', 'repo', 'conversationId'], 'metadata only — no secret/token field exists');
  for (const k of keys) assert.ok(!/secret|token|key|credential/i.test(k), `no credential-shaped param (${k})`);
});

test('request_connection: starts a session bound to the channel (end_user_id = projectId) and returns the link', async () => {
  const calls: { secretKey: string; endUserId: string; integrationId: string; tags?: Record<string, string> }[] = [];
  const fakeStart = async (a: { secretKey: string; endUserId: string; integrationId: string; tags?: Record<string, string> }) => {
    calls.push(a);
    return { connectLink: 'https://connect.nango.dev/xyz', token: 't', expiresAt: 'e' };
  };
  const tool = requestConnectionTool({ nangoSecretKey: 'nk', projectId: 'C123' }, { startConnectSession: fakeStart });
  const out = (await invokeTool(tool, { provider: 'notion' }));
  assert.match(out, /https:\/\/connect\.nango\.dev\/xyz/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    secretKey: 'nk',
    endUserId: 'C123',
    integrationId: 'notion',
    tags: { provider: 'notion', auth_mode: 'oauth' },
  });
});

test('request_connection: a catalog provider whose integration key is NOT enabled in Nango fails gracefully (no cryptic 400)', async () => {
  // github oauth resolves to key "github", but only github-app / the sample are enabled.
  const tool = requestConnectionTool(
    { nangoSecretKey: 'nk', projectId: 'C123', enabledIntegrationKeys: ['github-app', 'github-getting-started', 'notion'] },
    {
      startConnectSession: async () => {
        throw new Error('must not mint a session for a missing integration');
      },
    },
  );
  const out = await invokeTool(tool, { provider: 'github', authMode: 'oauth' });
  assert.match(out, /not enabled|isn't enabled/i, 'explains the integration is missing instead of a raw 400');
  assert.match(out, /github-app/, 'tells the agent which github integrations ARE enabled so it can fall back');
  assert.doesNotMatch(out, /https:\/\//, 'no link minted');
});

test('request_connection: a catalog provider whose key IS enabled proceeds normally', async () => {
  // github "app" resolves to "github-app-oauth" (MoreHands's integration key) — and it's in the enabled list.
  const tool = requestConnectionTool(
    { nangoSecretKey: 'nk', projectId: 'C123', enabledIntegrationKeys: ['github-app-oauth', 'notion'] },
    { startConnectSession: async () => ({ connectLink: 'https://connect.nango.dev/app', token: 't', expiresAt: 'e' }) },
  );
  const out = await invokeTool(tool, { provider: 'github', authMode: 'app' });
  assert.match(out, /connect\.nango\.dev\/app/, 'an enabled key mints the link as before');
});

test('request_connection: validation is skipped when the enabled list is unknown (back-compat)', async () => {
  // No enabledIntegrationKeys passed → no gating, mints as before (the existing call sites/tests).
  const tool = requestConnectionTool(
    { nangoSecretKey: 'nk', projectId: 'C123' },
    { startConnectSession: async () => ({ connectLink: 'https://connect.nango.dev/xyz', token: 't', expiresAt: 'e' }) },
  );
  const out = await invokeTool(tool, { provider: 'notion' });
  assert.match(out, /connect\.nango\.dev\/xyz/);
});

test('request_connection: with a thread poster, the high-entropy link goes to Slack and the model gets a URL-free result', async () => {
  const posted: { conversationId: string; text: string }[] = [];
  const fakeStart = async () => ({
    connectLink: 'https://connect.nango.dev/?session_token=AAAA-very-long-random-session-token-BBBB',
    token: 't',
    expiresAt: 'e',
  });
  const tool = requestConnectionTool(
    { nangoSecretKey: 'nk', projectId: 'C123' },
    {
      startConnectSession: fakeStart,
      postConnectionLink: async (i) => {
        posted.push(i);
        return true;
      },
    },
  );
  const out = await invokeTool(tool, { provider: 'notion', conversationId: 'slack:T:C:1.0' });
  // The link (the thing the model would otherwise stall reproducing token-by-token) is posted to Slack…
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /connect\.nango\.dev/);
  assert.equal(posted[0].conversationId, 'slack:T:C:1.0');
  // …and the model's tool result never contains the URL, so it can't echo it.
  assert.doesNotMatch(out, /connect\.nango\.dev/, 'the model never receives the URL');
  assert.match(out, /posted|shared/i, 'the model is told the link is already in the thread');
});

test('request_connection: falls back to returning the link in-result when no thread can be posted to', async () => {
  const fakeStart = async () => ({ connectLink: 'https://connect.nango.dev/xyz', token: 't', expiresAt: 'e' });
  // Poster wired, but no conversationId to target → must still get the link to the user somehow.
  const tool = requestConnectionTool(
    { nangoSecretKey: 'nk', projectId: 'C123' },
    { startConnectSession: fakeStart, postConnectionLink: async () => true },
  );
  const out = await invokeTool(tool, { provider: 'notion' });
  assert.match(out, /connect\.nango\.dev\/xyz/, 'without a conversationId, the link still reaches the model as before');
});

test('request_connection: if the direct post fails, the link falls back into the model result (never lost)', async () => {
  const fakeStart = async () => ({ connectLink: 'https://connect.nango.dev/zzz', token: 't', expiresAt: 'e' });
  const tool = requestConnectionTool(
    { nangoSecretKey: 'nk', projectId: 'C123' },
    { startConnectSession: fakeStart, postConnectionLink: async () => false },
  );
  const out = await invokeTool(tool, { provider: 'notion', conversationId: 'slack:T:C:1.0' });
  assert.match(out, /connect\.nango\.dev\/zzz/, 'a failed post must not swallow the link');
});

// ── GitHub App auth mode (Phase 2: the agent can offer it) ───────────────────

test('integrations: github supports the app auth mode → github-app-oauth integration key', () => {
  assert.ok(supportedAuthModes('github').includes('app'), 'github offers oauth, pat, AND app');
  assert.equal(normalizeAuthMode('github', 'app'), 'app');
  assert.equal(nangoIntegrationKey('github', 'app'), 'github-app-oauth');
});

test('integrations: app is github-only — linear/notion reject it', () => {
  assert.equal(normalizeAuthMode('linear', 'app'), null);
  assert.equal(normalizeAuthMode('notion', 'app'), null);
});

test('request_connection: GitHub App mints a github-app-oauth session, needs no repo, returns install copy', async () => {
  const calls: { integrationId: string; tags?: Record<string, string> }[] = [];
  const fakeStart = async (a: { secretKey: string; endUserId: string; integrationId: string; tags?: Record<string, string> }) => {
    calls.push({ integrationId: a.integrationId, tags: a.tags });
    return { connectLink: 'https://connect.nango.dev/app', token: 't', expiresAt: 'e' };
  };
  const tool = requestConnectionTool({ nangoSecretKey: 'nk', projectId: 'C123' }, { startConnectSession: fakeStart });
  const out = await invokeTool(tool, { provider: 'github', authMode: 'app' });
  assert.equal(calls.length, 1, 'app does NOT require a repo (unlike pat)');
  assert.equal(calls[0].integrationId, 'github-app-oauth');
  assert.deepEqual(calls[0].tags, { provider: 'github', auth_mode: 'app' });
  assert.match(out, /https:\/\/connect\.nango\.dev\/app/);
  assert.match(out, /install/i, 'copy explains it is an app install');
});

test('request_connection: GitHub OAuth can use an operator-configured Nango integration key', async () => {
  const calls: { secretKey: string; endUserId: string; integrationId: string; tags?: Record<string, string> }[] = [];
  const fakeStart = async (a: { secretKey: string; endUserId: string; integrationId: string; tags?: Record<string, string> }) => {
    calls.push(a);
    return { connectLink: 'https://connect.nango.dev/gh', token: 't', expiresAt: 'e' };
  };
  const tool = requestConnectionTool(
    {
      nangoSecretKey: 'nk',
      projectId: 'C123',
      nangoIntegrationKeys: { github: { oauth: 'github-oauth', pat: 'github-pat' } },
    },
    { startConnectSession: fakeStart },
  );
  const out = await invokeTool(tool, { provider: 'github', authMode: 'oauth' });
  assert.match(out, /github/i);
  assert.deepEqual(calls[0], {
    secretKey: 'nk',
    endUserId: 'C123',
    integrationId: 'github-oauth',
    tags: { provider: 'github', auth_mode: 'oauth' },
  });
  assert.match(out, /Connect GitHub/i);
  assert.doesNotMatch(out, /Share this link with the user/i);
  assert.doesNotMatch(out, /implementation|providerConfigKey|connection_ref/i);
});

test('request_connection: Linear OAuth returns Slack-ready setup copy', async () => {
  const fakeStart = async () => ({ connectLink: 'https://connect.nango.dev/linear', token: 't', expiresAt: 'e' });
  const tool = requestConnectionTool({ nangoSecretKey: 'nk', projectId: 'C123' }, { startConnectSession: fakeStart });
  const out = await invokeTool(tool, { provider: 'linear' });

  assert.match(out, /Connect Linear/i);
  assert.match(out, /https:\/\/connect\.nango\.dev\/linear/);
  assert.doesNotMatch(out, /Share this link with the user/i);
  assert.doesNotMatch(out, /implementation|providerConfigKey|connection_ref/i);
});

test('request_connection: GitHub PAT requires a repo and stores the repo as metadata only', async () => {
  const calls: { secretKey: string; endUserId: string; integrationId: string; tags?: Record<string, string> }[] = [];
  const fakeStart = async (a: { secretKey: string; endUserId: string; integrationId: string; tags?: Record<string, string> }) => {
    calls.push(a);
    return { connectLink: 'https://connect.nango.dev/pat', token: 't', expiresAt: 'e' };
  };
  const tool = requestConnectionTool(
    {
      nangoSecretKey: 'nk',
      projectId: 'C123',
      nangoIntegrationKeys: { github: { oauth: 'github-oauth', pat: 'github-pat' } },
    },
    { startConnectSession: fakeStart },
  );

  const missingRepo = await invokeTool(tool, { provider: 'github', authMode: 'pat' });
  assert.match(missingRepo, /owner\/name/i);
  assert.match(missingRepo, /acme\/widgets/i);
  assert.equal(calls.length, 0, 'no Nango session starts without a repo-bound PAT');

  const badRepo = await invokeTool(tool, { provider: 'github', authMode: 'pat', repo: 'https://github.com/Acme/Repo/pull/1' });
  assert.match(badRepo, /repo is required|repo must/i);
  assert.equal(calls.length, 0, 'no Nango session starts for a PR URL; route policy needs an exact repo');

  const out = await invokeTool(tool, { provider: 'github', authMode: 'pat', repo: 'Acme/Repo' });
  assert.match(out, /Acme\/Repo/);
  assert.match(out, /Connect GitHub PAT/i);
  assert.doesNotMatch(out, /Share this link with the user/i);
  assert.deepEqual(calls[0], {
    secretKey: 'nk',
    endUserId: 'C123',
    integrationId: 'github-pat',
    tags: { provider: 'github', auth_mode: 'pat', repo: 'Acme/Repo' },
  });
  assert.ok(!Object.keys(calls[0].tags ?? {}).some((k) => /secret|token|key|credential/i.test(k)));
});

test('request_connection: refuses a non-catalog provider NOT enabled in Nango (no session started)', async () => {
  let started = 0;
  const fakeStart = async () => { started++; return { connectLink: 'x', token: 't', expiresAt: 'e' }; };
  const fakeList = async () => [{ uniqueKey: 'airtable', provider: 'airtable', displayName: 'Airtable' }];
  const tool = requestConnectionTool({ nangoSecretKey: 'nk', projectId: 'C123' }, { startConnectSession: fakeStart, listIntegrations: fakeList });
  const out = await invokeTool(tool, { provider: 'salesforce' });
  assert.match(out, /not enabled in this workspace/i);
  assert.match(out, /airtable/i, 'tells the agent what IS enabled');
  assert.equal(started, 0, 'no Nango session for a provider Nango does not have');
});

test('request_connection: accepts a non-catalog provider that IS enabled in Nango (generic path)', async () => {
  const sessions: { integrationId: string; tags?: Record<string, string> }[] = [];
  const fakeStart = async (a: { integrationId: string; tags?: Record<string, string> }) => {
    sessions.push({ integrationId: a.integrationId, tags: a.tags });
    return { connectLink: 'https://connect.nango.dev/air', token: 't', expiresAt: 'e' };
  };
  const fakeList = async () => [{ uniqueKey: 'airtable', provider: 'airtable', displayName: 'Airtable' }];
  const tool = requestConnectionTool({ nangoSecretKey: 'nk', projectId: 'C123' }, { startConnectSession: fakeStart, listIntegrations: fakeList });
  const out = await invokeTool(tool, { provider: 'Airtable' });
  assert.match(out, /connect\.nango\.dev\/air/);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].integrationId, 'airtable', 'session locked to the Nango integration key');
  assert.equal(sessions[0].tags?.provider, 'airtable', 'tags carry the provider slug for the webhook');
});

// A fake DB for the disconnect tool: supports loadConnections (SELECT provider, token_ref…) and
// disableConnectionByRef (SELECT project_id, provider WHERE connection_ref + UPDATE status).
function disconnectFakeD1(rows: { project_id: string; provider: string; connection_ref: string | null; status: string; config_json?: string | null }[]): D1Like {
  return {
    prepare(sql: string) {
      const t = sql.trim();
      return {
        bind: (...args: unknown[]) => ({
          run: async () => {
            if (t.startsWith('UPDATE connections SET status=')) {
              const ref = args[args.length - 1];
              const row = rows.find((r) => r.connection_ref === ref);
              if (row) row.status = 'disabled';
            }
            return {};
          },
          all: async <T = Record<string, unknown>>() => {
            if (t.startsWith('SELECT provider, token_ref')) {
              const [pid] = args;
              return {
                results: rows
                  .filter((r) => r.project_id === pid)
                  .map((r) => ({
                    provider: r.provider,
                    token_ref: null,
                    connection_ref: r.connection_ref,
                    config_json: r.config_json ?? null,
                    status: r.status,
                  })) as T[],
              };
            }
            return { results: [] as T[] };
          },
          first: async <T = Record<string, unknown>>() => {
            if (t.startsWith('SELECT project_id, provider FROM connections WHERE connection_ref')) {
              const [ref] = args;
              const row = rows.find((r) => r.connection_ref === ref && r.status === 'active');
              return (row ? { project_id: row.project_id, provider: row.provider } : null) as T | null;
            }
            return null as T | null;
          },
        }),
      };
    },
  };
}

test('disconnect_connection: schema has provider but NO secret param; deletes at Nango + disables the local row', async () => {
  const rows = [{ project_id: 'C123', provider: 'notion', connection_ref: 'conn_42', status: 'active' }];
  const db = disconnectFakeD1(rows);
  const deleted: { secretKey: string; connectionId: string; providerConfigKey: string }[] = [];
  const fakeDelete = async (a: { secretKey: string; connectionId: string; providerConfigKey: string }) => { deleted.push(a); };
  const tool = disconnectConnectionTool({ nangoSecretKey: 'nk', projectId: 'C123', db }, { deleteConnection: fakeDelete });

  assert.equal(tool.name, 'disconnect_connection');
  const props = (tool.input as v.ObjectSchema<v.ObjectEntries, undefined>).entries;
  assert.deepEqual(Object.keys(props), ['provider'], 'only a provider param — no secret');

  const out = await invokeTool(tool, { provider: 'notion' });
  assert.match(out, /🔌|disconnect/i);
  assert.deepEqual(deleted, [{ secretKey: 'nk', connectionId: 'conn_42', providerConfigKey: 'notion' }], 'revoked at Nango by connection_ref');
  assert.equal(rows[0].status, 'disabled', 'local row disabled → tool disappears next turn');
});

test('disconnect_connection: revokes with config.nangoIntegrationKey for GitHub PAT integrations', async () => {
  const rows = [{
    project_id: 'C123',
    provider: 'github',
    connection_ref: 'conn_pat',
    status: 'active',
    config_json: JSON.stringify({ authMode: 'pat', repo: 'acme/repo', nangoIntegrationKey: 'github-pat' }),
  }];
  const db = disconnectFakeD1(rows);
  const deleted: { secretKey: string; connectionId: string; providerConfigKey: string }[] = [];
  const fakeDelete = async (a: { secretKey: string; connectionId: string; providerConfigKey: string }) => { deleted.push(a); };
  const tool = disconnectConnectionTool({ nangoSecretKey: 'nk', projectId: 'C123', db }, { deleteConnection: fakeDelete });

  const out = await invokeTool(tool, { provider: 'github' });
  assert.match(out, /disconnect/i);
  assert.deepEqual(deleted, [{ secretKey: 'nk', connectionId: 'conn_pat', providerConfigKey: 'github-pat' }]);
});

test('disconnect_connection: not-connected provider → friendly message, no Nango call', async () => {
  const db = disconnectFakeD1([]); // no rows for this channel
  let deletes = 0;
  const fakeDelete = async () => { deletes++; };
  const tool = disconnectConnectionTool({ nangoSecretKey: 'nk', projectId: 'C123', db }, { deleteConnection: fakeDelete });
  const out = await invokeTool(tool, { provider: 'notion' });
  assert.match(out, /not connected|nothing to disconnect/i);
  assert.equal(deletes, 0, 'no Nango call when there is no connection to remove');
});

test('connectionsBlock: canRequest=true tells the agent to use request_connection; default does not', async () => {
  const withReq = connectionsBlock(connectionState(GH, {}), PROVIDER_CATALOG, true);
  assert.match(withReq, /request_connection/);
  const without = connectionsBlock(connectionState(GH, {}), PROVIDER_CATALOG);
  assert.doesNotMatch(without, /request_connection/);
  assert.match(without, /wired by an operator first/);
});

// ── Generic Nango providers (anything enabled in the Nango dashboard) ───────────────────────────

test('dynamicApiProfile: builds a direct Bearer profile from the persisted Nango spec', async () => {
  const config = { api: { baseUrl: 'https://api.airtable.com', headers: { 'x-airtable-thing': 'v1' }, authMode: 'OAUTH2', docs: 'https://nango.dev/docs/api-integrations/airtable' } };
  const profile = dynamicApiProfile('airtable', config)!;
  assert.equal(profile.baseUrl, 'https://api.airtable.com');
  assert.deepEqual(profile.auth('tok'), { authorization: 'Bearer tok' });
  assert.deepEqual(profile.staticHeaders, { 'x-airtable-thing': 'v1' });
  assert.equal(profile.methodPolicy, 'get-post', 'generic default blocks destructive verbs');
  assert.match(profile.crib(config), /api\.airtable\.com/);
});

test('dynamicApiProfile: null without a persisted spec or for non-Bearer auth (→ proxy fallback)', async () => {
  assert.equal(dynamicApiProfile('airtable', {}), null, 'no spec persisted');
  assert.equal(dynamicApiProfile('onepassword', { api: { baseUrl: 'https://x.test', authMode: 'API_KEY' } }), null, 'API_KEY auth cannot go direct');
});

test('nangoProxyProfile: routes via api.nango.dev with connection-id + provider-config-key headers', async () => {
  const profile = nangoProxyProfile('salesforce', { connectionRef: 'conn-9', providerConfigKey: 'salesforce' });
  assert.equal(profile.baseUrl, 'https://api.nango.dev/proxy');
  assert.deepEqual(profile.staticHeaders, { 'provider-config-key': 'salesforce', 'connection-id': 'conn-9' });
  assert.equal(profile.methodPolicy, 'get-post');
});

test('get-post policy: POST passes the gate, DELETE/PUT/PATCH are blocked with the operator hint', async () => {
  const profile = nangoProxyProfile('salesforce', { connectionRef: 'c', providerConfigKey: 'salesforce' });
  const tool = genericApiTool(profile, 'nk', {});
  for (const method of ['DELETE', 'PUT', 'PATCH']) {
    await assert.rejects(
      () => invokeTool(tool, { method, path: '/v1/things/1' }),
      /blocked .* methodPolicy/i,
      `${method} must be blocked`,
    );
  }
});

test('effectiveMethodPolicy: per-connection config override beats the profile default both ways', async () => {
  const profile = nangoProxyProfile('x', { connectionRef: 'c', providerConfigKey: 'x' });
  assert.equal(effectiveMethodPolicy(profile, {}), 'get-post');
  assert.equal(effectiveMethodPolicy(profile, { methodPolicy: 'all' }), 'all', 'operator opt-in to writes');
  assert.equal(effectiveMethodPolicy(profile, { methodPolicy: 'get-only' }), 'get-only', 'operator lockdown');
  assert.equal(effectiveMethodPolicy(profile, { methodPolicy: 'bogus' }), 'get-post', 'garbage override ignored');
  // Enforcement follows the override: get-only via config blocks even POST.
  const lockedTool = genericApiTool(profile, 'nk', { methodPolicy: 'get-only' });
  await assert.rejects(
    () => invokeTool(lockedTool, { method: 'POST', path: '/v1/q' }),
    /Only GET is allowed/,
  );
});

test('connectionTools: generic provider gets the direct tool with a spec, the proxy tool without one', async () => {
  const env = { NANGO_SECRET_KEY: 'nk_secret' };
  // With a persisted spec → direct dynamic profile.
  const DIRECT: ConnectionSpec[] = [{ provider: 'airtable', connectionRef: 'conn-1', config: { nangoIntegrationKey: 'airtable', api: { baseUrl: 'https://api.airtable.com', authMode: 'OAUTH2' } } }];
  const directCreds = resolveConnection(DIRECT, env, 'airtable')!;
  const directNames = connectionTools(connectionState(DIRECT, env), { airtable: directCreds }, 'nk_secret').map((t) => t.name as string);
  assert.deepEqual(directNames, ['airtable_call_api']);
  // Without a spec → proxy fallback (needs the Nango key + connectionRef).
  const PROXIED: ConnectionSpec[] = [{ provider: 'salesforce', connectionRef: 'conn-2', config: { nangoIntegrationKey: 'salesforce' } }];
  const proxiedCreds = resolveConnection(PROXIED, env, 'salesforce')!;
  const proxiedNames = connectionTools(connectionState(PROXIED, env), { salesforce: proxiedCreds }, 'nk_secret').map((t) => t.name as string);
  assert.deepEqual(proxiedNames, ['salesforce_call_api']);
  // Without the Nango key arg the proxy fallback cannot route → degrades to toolless, not a crash.
  assert.equal(connectionTools(connectionState(PROXIED, env), { salesforce: proxiedCreds }).length, 0);
});

test('connectionsBlock: a connected provider outside the curated catalog still gets a line', async () => {
  const state = connectionState(
    [{ provider: 'airtable', connectionRef: 'conn-1', config: {} }] as ConnectionSpec[],
    { NANGO_SECRET_KEY: 'nk' },
  );
  const block = connectionsBlock(state, PROVIDER_CATALOG, true);
  assert.match(block, /✅ airtable \(connected\) — generic API access via airtable_call_api/);
});

test('tavily: Worker-secret connection exposes the generic search tool, POST allowed, writes refused', async () => {
  const TAVILY: ConnectionSpec[] = [{ provider: 'tavily', tokenRef: 'TAVILY_API_KEY', config: {} }];
  assert.equal(connectionTools(connectionState(TAVILY, {}), {}).length, 0, 'no tool before the key is set');

  const env = { TAVILY_API_KEY: 'tvly-secret' };
  const creds = resolveConnection(TAVILY, env, 'tavily')!;
  const tools = connectionTools(connectionState(TAVILY, env), { tavily: creds });
  const callApi = tools.find((t) => t.name === 'tavily_call_api');
  assert.ok(callApi, 'tavily gets the generic call tool (no typed tools)');
  assert.match(String(callApi.description), /POST \/search/, 'crib teaches the search body shape');
  // get-post policy: search/extract POSTs pass the gate; mutating verbs are refused outright.
  await assert.rejects(
    () => invokeTool(callApi, { method: 'DELETE', path: '/search' }),
    /blocked for tavily/,
  );
  assert.doesNotMatch(JSON.stringify(tools.map((t) => t.description)), /tvly-secret/, 'the key never leaks into tool text');
});

await run();
