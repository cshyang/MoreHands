// Binding D1 cascade + auto-create invariants — run: npx tsx src/project/bindings.test.ts
// Mirrors the connections D1+seed pattern: D1 rows are the live source merged OVER the
// bindings.ts seed; the gateway auto-creates a per-channel binding (race-safe, team-allowlisted).
// Load-bearing: the bot token is referenced by NAME (transport_token_ref), never stored; auto-create
// is gated to KNOWN_TEAM_IDS so "any channel" can never become "any workspace".

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import {
  loadBindings,
  upsertBinding,
  autoCreateBinding,
  setBindingOverhear,
  bindingRecordToBinding,
  bindingBySlack,
  bindingByProject,
  resolveModel,
  assertValidModel,
  DEFAULT_MODEL,
  hasCataloguedModel,
  agentInstanceId,
  parseAgentInstanceId,
  type BindingRecord,
} from './bindings';
import type { D1Like } from '../skills/repository';

// In-memory D1 fake covering only the two statements bindings.ts issues.
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
  #mutate(sql: string, a: unknown[]) {
    if (sql.startsWith('UPDATE bindings SET overhear')) {
      // setBindingOverhear: [overhear, updated_at, project_id]
      const [overhear, updatedAt, projectId] = a;
      const row = this.rows.find((r) => r.project_id === projectId);
      if (row) Object.assign(row, { overhear, updated_at: updatedAt });
      return;
    }
    if (!sql.startsWith('INSERT INTO bindings')) return;
    // Both inserts share the same 11-bind column order:
    // [project_id, 'slack', account, space, bot, tokenRef, model, status, created_by, created_at, updated_at]
    const [projectId, , accountId, spaceId, botId, tokenRef, model, status, createdBy, createdAt, updatedAt] = a;
    const existing = this.rows.find((r) => r.project_id === projectId);
    if (existing) {
      if (sql.includes('DO NOTHING')) return; // autoCreateBinding: ignore on conflict
      // upsertBinding: DO UPDATE — overwrite mutable fields, preserve created_at.
      Object.assign(existing, {
        external_account_id: accountId, external_space_id: spaceId, transport_bot_id: botId,
        transport_token_ref: tokenRef, model, status, updated_at: updatedAt,
      });
      return;
    }
    this.rows.push({
      project_id: projectId, provider: 'slack', external_account_id: accountId, external_space_id: spaceId,
      transport_bot_id: botId, transport_token_ref: tokenRef, model,
      status, created_by: createdBy, created_at: createdAt, updated_at: updatedAt,
    });
  }
  #query(sql: string, a: unknown[]): Row[] {
    if (sql.startsWith('SELECT project_id, external_account_id')) {
      // loadBindings(projectId?) — if a projectId arg is bound, filter; else all.
      return a.length ? this.rows.filter((r) => r.project_id === a[0]) : this.rows;
    }
    return [];
  }
}

const { test, run } = createTestRunner();

test('autoCreateBinding inserts a per-channel row keyed by channel id, token by ref', async () => {
  const db = new FakeD1();
  await autoCreateBinding(db, {
    teamId: 'T0B6VB415TQ',
    channelId: 'C_NEW',
    transportBotId: 'U0B6UB2E5HT',
    transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
  });
  const rows = await loadBindings(db, 'C_NEW');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].projectId, 'C_NEW', 'project_id = channel id');
  assert.equal(rows[0].externalSpaceId, 'C_NEW');
  assert.equal(rows[0].externalAccountId, 'T0B6VB415TQ');
  assert.equal(rows[0].transportTokenRef, 'SLACK_BOT_TOKEN_DEFAULT', 'token is a REF, not a value');
  assert.equal(rows[0].status, 'active');
});

test('autoCreateBinding is race-safe: a second call for the same channel is a no-op (DO NOTHING)', async () => {
  const db = new FakeD1();
  const args = { teamId: 'T0B6VB415TQ', channelId: 'C_DUP', transportBotId: 'U', transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT' };
  await autoCreateBinding(db, args);
  await autoCreateBinding(db, args);
  const rows = await loadBindings(db, 'C_DUP');
  assert.equal(rows.length, 1, 'exactly one row after two creates');
});

test('overhear defaults off, setBindingOverhear flips it, and loadBindings reads it back', async () => {
  const db = new FakeD1();
  await autoCreateBinding(db, { teamId: 'T', channelId: 'C_OH', transportBotId: 'U', transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT' });
  assert.equal((await loadBindings(db, 'C_OH'))[0].overhear, false, 'defaults off');

  await setBindingOverhear(db, 'C_OH', true);
  assert.equal((await loadBindings(db, 'C_OH'))[0].overhear, true, 'turned on');

  await setBindingOverhear(db, 'C_OH', false);
  assert.equal((await loadBindings(db, 'C_OH'))[0].overhear, false, 'turned back off');
});

test('bindingRecordToBinding carries overhear through', () => {
  assert.equal(bindingRecordToBinding({
    projectId: 'C_X', provider: 'slack', externalAccountId: 'T', externalSpaceId: 'C_X',
    transportBotId: 'U', transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT', overhear: true, status: 'active',
  }).overhear, true);
});

test('bindingRecordToBinding maps a D1 row to the Binding shape the app consumes', async () => {
  const rec: BindingRecord = {
    projectId: 'C_X', provider: 'slack', externalAccountId: 'T0B6VB415TQ', externalSpaceId: 'C_X',
    transportBotId: 'U', transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    model: undefined, status: 'active',
  };
  const b = bindingRecordToBinding(rec);
  assert.equal(b.provider, 'slack');
  assert.equal(b.projectId, 'C_X');
  assert.equal(b.externalSpaceId, 'C_X');
  assert.equal(b.sandboxMode, 'virtual', 'defaults filled for fields not stored in D1');
  assert.equal(b.status, 'active');
});

test('bindingBySlack: seed wins first; falls back to D1 for an auto-created channel', async () => {
  const db = new FakeD1();
  // the demo seed row resolves with NO db touch
  const seedHit = await bindingBySlack('T0B6VB415TQ', 'C0B6VFMVCUW', db);
  assert.equal(seedHit?.projectId, 'demo', 'seed row resolves');

  // an unknown channel is not in the seed → undefined until a D1 row exists
  assert.equal(await bindingBySlack('T0B6VB415TQ', 'C_NEW', db), undefined);

  // after auto-create, the same lookup resolves from D1
  await autoCreateBinding(db, { teamId: 'T0B6VB415TQ', channelId: 'C_NEW', transportBotId: 'U0B6UB2E5HT', transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT' });
  const d1Hit = await bindingBySlack('T0B6VB415TQ', 'C_NEW', db);
  assert.equal(d1Hit?.projectId, 'C_NEW', 'D1 row resolves after auto-create');
  assert.equal(d1Hit?.transportTokenRef, 'SLACK_BOT_TOKEN_DEFAULT');
});

test('bindingByProject: resolves a D1-only channel project', async () => {
  const db = new FakeD1();
  assert.equal((await bindingByProject('demo', db))?.projectId, 'demo', 'seed');
  await autoCreateBinding(db, { teamId: 'T0B6VB415TQ', channelId: 'C_P', transportBotId: 'U', transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT' });
  assert.equal((await bindingByProject('C_P', db))?.projectId, 'C_P', 'D1');
});

test('disabled D1 binding does not resolve', async () => {
  const db = new FakeD1();
  await upsertBinding(db, {
    projectId: 'C_OFF', provider: 'slack', externalAccountId: 'T0B6VB415TQ', externalSpaceId: 'C_OFF',
    transportBotId: 'U', transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    status: 'disabled',
  });
  assert.equal(await bindingBySlack('T0B6VB415TQ', 'C_OFF', db), undefined, 'disabled is not active');
  assert.equal(await bindingByProject('C_OFF', db), undefined);
});

test('upsertBinding overwrites an existing row (DO UPDATE), preserving project_id', async () => {
  const db = new FakeD1();
  await autoCreateBinding(db, { teamId: 'T0B6VB415TQ', channelId: 'C_UP', transportBotId: 'U1', transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT' });
  // operator overwrites the bot id + pins a model on the SAME project
  await upsertBinding(db, {
    projectId: 'C_UP', provider: 'slack', externalAccountId: 'T0B6VB415TQ', externalSpaceId: 'C_UP',
    transportBotId: 'U2_CHANGED', transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    model: 'openrouter/xiaomi/mimo-v2.5-pro', status: 'active',
  });
  const rows = await loadBindings(db, 'C_UP');
  assert.equal(rows.length, 1, 'still one row (overwrite, not insert)');
  assert.equal(rows[0].transportBotId, 'U2_CHANGED', 'DO UPDATE overwrote the bot id');
  assert.equal(rows[0].model, 'openrouter/xiaomi/mimo-v2.5-pro', 'DO UPDATE applied the model pin');
});

// Capture console.warn for the duration of a call, then restore it.
function captureWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  return { lines, restore: () => { console.warn = orig; } };
}

test('resolveModel: a validated model passes through with no warning', async () => {
  const w = captureWarn();
  const out = resolveModel('openrouter/xiaomi/mimo-v2.5-pro');
  w.restore();
  assert.equal(out, 'openrouter/xiaomi/mimo-v2.5-pro');
  assert.equal(w.lines.length, 0, 'no warning for a catalogued/validated model');
});

test('resolveModel: undefined falls back to DEFAULT_MODEL, no warning', async () => {
  const w = captureWarn();
  const out = resolveModel(undefined);
  w.restore();
  assert.equal(out, DEFAULT_MODEL, 'unpinned binding → DEFAULT_MODEL');
  assert.equal(w.lines.length, 0, 'DEFAULT_MODEL is itself validated');
});

test('resolveModel: an unvalidated model is respected (not swapped) but flagged loudly', async () => {
  const w = captureWarn();
  const out = resolveModel('openrouter/acme/unknown-99b');
  w.restore();
  assert.equal(out, 'openrouter/acme/unknown-99b', 'operator intent is respected, never silently swapped');
  assert.equal(w.lines.length, 1, 'unvalidated model is warned');
  assert.match(w.lines[0], /model-guard/, 'warning is greppable by tag');
});

test('resolveModel: warns at most once per model id (no per-turn log spam)', async () => {
  const w = captureWarn();
  resolveModel('openrouter/acme/dup-model');
  resolveModel('openrouter/acme/dup-model');
  resolveModel('openrouter/acme/dup-model');
  w.restore();
  assert.equal(w.lines.length, 1, 'repeat resolves of the same id stay silent');
});

test('native catalog guards the approved flash default without claiming performance validation', () => {
  assert.equal(DEFAULT_MODEL, 'zai/glm-5.3-flash');
  assert.equal(hasCataloguedModel(DEFAULT_MODEL), true);
  assert.doesNotThrow(() => assertValidModel(DEFAULT_MODEL));
  assert.equal(hasCataloguedModel('zai/not-a-model'), false);
  assert.equal(hasCataloguedModel('unknown/glm-5.3-flash'), false);
});

test('assertValidModel: validated and unpinned (null/undefined/empty) all pass', async () => {
  assert.doesNotThrow(() => assertValidModel('openrouter/xiaomi/mimo-v2.5-pro'));
  assert.doesNotThrow(() => assertValidModel(undefined));
  assert.doesNotThrow(() => assertValidModel(null));
  assert.doesNotThrow(() => assertValidModel(''));
});

test('assertValidModel: an unvalidated pinned model throws', async () => {
  assert.throws(() => assertValidModel('openrouter/acme/unknown-77b'), /model-guard/);
});

test('upsertBinding rejects an unvalidated model pin — bad config never enters D1', async () => {
  const db = new FakeD1();
  await assert.rejects(
    upsertBinding(db, {
      projectId: 'C_BAD', provider: 'slack', externalAccountId: 'T0B6VB415TQ', externalSpaceId: 'C_BAD',
      transportBotId: 'U', transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
      model: 'openrouter/acme/nope', status: 'active',
    }),
    /model-guard/,
  );
  assert.equal((await loadBindings(db, 'C_BAD')).length, 0, 'no row written on rejection');
});

test('upsertBinding accepts a validated model pin', async () => {
  const db = new FakeD1();
  await upsertBinding(db, {
    projectId: 'C_OK', provider: 'slack', externalAccountId: 'T0B6VB415TQ', externalSpaceId: 'C_OK',
    transportBotId: 'U', transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    model: 'openrouter/xiaomi/mimo-v2.5-pro', status: 'active',
  });
  const rows = await loadBindings(db, 'C_OK');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, 'openrouter/xiaomi/mimo-v2.5-pro', 'validated pin is stored');
});

test('autoCreateBinding rejects an unvalidated model pin', async () => {
  const db = new FakeD1();
  await assert.rejects(
    autoCreateBinding(db, {
      teamId: 'T0B6VB415TQ', channelId: 'C_ACB', transportBotId: 'U',
      transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT', model: 'totally/madeup',
    }),
    /model-guard/,
  );
  assert.equal((await loadBindings(db, 'C_ACB')).length, 0, 'no row written');
});

test('agentInstanceId round-trips through parseAgentInstanceId (with the session-generation token)', () => {
  // Build → parse recovers projectId/slug/scope; the @g token must not leak into any of them.
  for (const [scope, expectScope] of [
    ['conv:slack:T1:C1:100.000', 'conv:slack:T1:C1:100.000'],
    ['conv:slack:T1:C1:100.000~e3', 'conv:slack:T1:C1:100.000~e3'], // epoch + generation token compose: strip @g, keep ~e3
    ['heartbeat', 'heartbeat'],
    ['job:abc', 'job:abc'],
    [undefined, null],
  ] as const) {
    const id = agentInstanceId('proj_1', scope, 'default');
    assert.match(id, /@g\d+$/, `expected a generation token on ${id}`);
    assert.deepEqual(parseAgentInstanceId(id), { projectId: 'proj_1', slug: 'default', scope: expectScope });
  }
});

test('the session generation makes the id differ from the legacy (pre-bump) id → a fresh DO', () => {
  const id = agentInstanceId('proj_1', 'conv:X');
  assert.equal(id, 'project:proj_1:agent:default/conv:X@g2');
  assert.notEqual(id, 'project:proj_1:agent:default/conv:X@g1', 'Flue 2 must not read incompatible generation-1 session state');
});

test('parseAgentInstanceId still resolves legacy ids with no generation token (back-compat)', () => {
  assert.deepEqual(parseAgentInstanceId('project:proj_1:agent:default/conv:X'), {
    projectId: 'proj_1',
    slug: 'default',
    scope: 'conv:X',
  });
  // bare legacy id (no :agent: suffix)
  assert.deepEqual(parseAgentInstanceId('project:proj_1'), { projectId: 'proj_1', slug: 'default', scope: null });
});

await run();
