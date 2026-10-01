// User name resolution invariants — run: npx tsx src/knowledge/users.test.ts
// Load-bearing: parse the senderId shape; cache-first (no Slack call on a fresh hit); TTL expiry
// re-fetches; a non-user id (agent/unknown) resolves to null without any lookup; the cache stores
// names only (never a token).

import assert from 'node:assert/strict';
import { createTestRunner, invokeTool } from '../shared/test-utils';
import {
  parseSenderId,
  resolveUserName,
  loadCachedProfile,
  cacheProfile,
  profileLabel,
  userTools,
} from './users';
import type { D1Like } from '../skills/repository';

interface Row {
  [k: string]: unknown;
}
class FakeD1 implements D1Like {
  rows: Row[] = [];
  prepare(sql: string) {
    const t = sql.trim();
    return {
      bind: (...a: unknown[]) => ({
        run: async (): Promise<unknown> => {
          this.#mutate(t, a);
          return {};
        },
        all: async <T = Record<string, unknown>>(): Promise<{ results: T[] }> => ({ results: this.#query(t, a) as T[] }),
        first: async <T = Record<string, unknown>>(): Promise<T | null> => (this.#query(t, a)[0] ?? null) as T | null,
      }),
    };
  }
  #mutate(sql: string, a: unknown[]) {
    if (sql.startsWith('INSERT INTO user_profiles')) {
      const [account, user, display, real, cachedAt] = a;
      const existing = this.rows.find((r) => r.external_account_id === account && r.external_user_id === user);
      if (existing) Object.assign(existing, { display_name: display, real_name: real, cached_at: cachedAt });
      else this.rows.push({ provider: 'slack', external_account_id: account, external_user_id: user, display_name: display, real_name: real, cached_at: cachedAt });
    }
  }
  #query(sql: string, a: unknown[]): Row[] {
    if (sql.startsWith('SELECT display_name')) {
      const [, account, user] = a; // bind order: ('slack', account, user)
      return this.rows.filter((r) => r.external_account_id === account && r.external_user_id === user);
    }
    return [];
  }
}

const { test, run } = createTestRunner();

test('parseSenderId: handles slack:team:user, bare id, and rejects agent/unknown/garbage', async () => {
  assert.deepEqual(parseSenderId('slack:T1:U2'), { provider: 'slack', accountId: 'T1', userId: 'U2' });
  assert.deepEqual(parseSenderId('U0B6VBZ3HRC'), { provider: 'slack', accountId: '', userId: 'U0B6VBZ3HRC' });
  assert.equal(parseSenderId('agent'), null);
  assert.equal(parseSenderId('unknown'), null);
  assert.equal(parseSenderId(''), null);
  assert.equal(parseSenderId('not an id'), null);
});

test('profileLabel: display name preferred, then real name, then null', async () => {
  assert.equal(profileLabel({ displayName: 'shy', realName: 'Shyang C' }), 'shy');
  assert.equal(profileLabel({ realName: 'Shyang C' }), 'Shyang C');
  assert.equal(profileLabel({}), null);
});

test('resolveUserName: a non-user id resolves to null WITHOUT any token/db touch', async () => {
  // token deliberately undefined; must not throw, must return null for 'agent'.
  assert.equal(await resolveUserName(undefined, undefined, 'agent'), null);
});

test('resolveUserName: cache hit returns the cached name and does NOT call Slack', async () => {
  const db = new FakeD1();
  const now = 1_000_000;
  await cacheProfile(db, 'T1', 'U2', { displayName: 'cachedName' }, now);
  // token is a sentinel that WOULD throw if fetch were attempted (it isn't, because cache is fresh).
  const name = await resolveUserName(db, 'xoxb-would-fail-if-used', 'slack:T1:U2', now + 1000);
  assert.equal(name, 'cachedName');
});

test('resolveUserName: expired cache + no token → null (cannot live-look-up)', async () => {
  const db = new FakeD1();
  const now = 1_000_000;
  await cacheProfile(db, 'T1', 'U2', { displayName: 'stale' }, now);
  const TTL = 7 * 24 * 60 * 60 * 1000;
  // now + TTL + 1 → cache is expired; no token → returns null rather than serving stale or throwing.
  const name = await resolveUserName(db, undefined, 'slack:T1:U2', now + TTL + 1);
  assert.equal(name, null);
});

test('loadCachedProfile: stores and reads back names only (no secret field)', async () => {
  const db = new FakeD1();
  await cacheProfile(db, 'T1', 'U9', { displayName: 'd', realName: 'r' }, 5);
  const got = await loadCachedProfile(db, 'T1', 'U9');
  assert.equal(got?.displayName, 'd');
  assert.equal(got?.realName, 'r');
  assert.equal(got?.cachedAt, 5);
  assert.ok(!('token' in (got as object)) && !('secret' in (got as object)));
});

test('userTools: exposes exactly resolve_user', async () => {
  const names = userTools(new FakeD1(), 'xoxb').map((t) => t.name as string);
  assert.deepEqual(names, ['resolve_user']);
});

test('resolve_user tool: returns a friendly message for an unresolvable id', async () => {
  const [tool] = userTools(new FakeD1(), undefined);
  const out = await invokeTool(tool, { user: 'agent' });
  assert.match(String(out), /No name available/);
});

await run();
