// User name resolution (the agent knows people by name, not just opaque Slack id).
//
// WHY a lookup at all: a Slack message event carries only the sender's USER ID (e.g. "U0B6VBZ3HRC"),
// never their name — names change, so Slack makes you resolve the id against the live directory via
// users.info (needs the `users:read` scope). The model already receives senderId in its turn input;
// this gives it an on-demand `resolve_user` tool to turn that id into a name, CACHED in D1 so each
// person is looked up at most once (until the TTL), and only for people the agent actually asks about.

import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import { fetchWithTimeout } from '../providers/http';
import type { D1Like } from '../skills/repository';

const SLACK_API = 'https://slack.com/api';
const FETCH_TIMEOUT_MS = 8000; // bound the users.info call well under the DO turn budget
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d — names rarely change; re-resolve weekly

/** Parse the dispatch senderId ("slack:<team>:<user>") or a bare Slack user id ("U…"). Returns the
 *  pieces, or null if it's neither (e.g. 'agent' or 'unknown'). */
export function parseSenderId(input: string): { provider: string; accountId: string; userId: string } | null {
  const s = String(input ?? '').trim();
  if (!s || s === 'agent' || s === 'unknown') return null;
  const m = s.match(/^slack:([^:]+):([^:]+)$/);
  if (m) return { provider: 'slack', accountId: m[1], userId: m[2] };
  if (/^[UW][A-Z0-9]+$/.test(s)) return { provider: 'slack', accountId: '', userId: s }; // bare id
  return null;
}

export interface CachedProfile {
  displayName?: string;
  realName?: string;
  cachedAt: number;
}

export async function loadCachedProfile(
  db: D1Like,
  accountId: string,
  userId: string,
): Promise<CachedProfile | null> {
  const row = await db
    .prepare(
      'SELECT display_name, real_name, cached_at FROM user_profiles WHERE provider=? AND external_account_id=? AND external_user_id=?',
    )
    .bind('slack', accountId, userId)
    .first<{ display_name: string | null; real_name: string | null; cached_at: number }>();
  if (!row) return null;
  return { displayName: row.display_name ?? undefined, realName: row.real_name ?? undefined, cachedAt: row.cached_at };
}

export async function cacheProfile(
  db: D1Like,
  accountId: string,
  userId: string,
  profile: { displayName?: string; realName?: string },
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_profiles(provider, external_account_id, external_user_id, display_name, real_name, cached_at)
       VALUES('slack', ?, ?, ?, ?, ?)
       ON CONFLICT(provider, external_account_id, external_user_id) DO UPDATE SET
         display_name=excluded.display_name, real_name=excluded.real_name, cached_at=excluded.cached_at`,
    )
    .bind(accountId, userId, profile.displayName ?? null, profile.realName ?? null, now)
    .run();
}

interface SlackUsersInfo {
  ok: boolean;
  error?: string;
  user?: { profile?: { display_name?: string; real_name?: string }; real_name?: string; name?: string };
}

/** Call Slack users.info to resolve a user id → names. Throws a sanitized error (never the token). */
export async function fetchSlackProfile(
  token: string,
  userId: string,
): Promise<{ displayName?: string; realName?: string }> {
  const res = await fetchWithTimeout(`${SLACK_API}/users.info?user=${encodeURIComponent(userId)}`, {
    headers: { authorization: `Bearer ${token}` },
  }, {
    timeoutMs: FETCH_TIMEOUT_MS,
    timeoutMessage: `users.info timed out after ${FETCH_TIMEOUT_MS}ms`,
    failurePrefix: 'users.info failed',
  });
  const data = (await res.json()) as SlackUsersInfo;
  if (!data.ok) throw new Error(`users.info: ${data.error ?? 'unknown_error'}`);
  const p = data.user?.profile;
  return {
    displayName: p?.display_name || data.user?.name || undefined,
    realName: p?.real_name || data.user?.real_name || undefined,
  };
}

/** Pick the best human label from a profile (display name preferred, then real name). */
export function profileLabel(p: { displayName?: string; realName?: string }): string | null {
  return p.displayName || p.realName || null;
}

/** Resolve a senderId/user-id to a human name: cache-first, then Slack, then re-cache. Returns null
 *  if it can't be resolved (not a real user id, or Slack lookup fails). `now` is injectable for tests. */
export async function resolveUserName(
  db: D1Like | undefined,
  token: string | undefined,
  senderOrUserId: string,
  now: number = Date.now(),
): Promise<string | null> {
  const parsed = parseSenderId(senderOrUserId);
  if (!parsed) return null;
  const { accountId, userId } = parsed;

  if (db) {
    const cached = await loadCachedProfile(db, accountId, userId).catch(() => null);
    if (cached && now - cached.cachedAt < CACHE_TTL_MS) return profileLabel(cached);
  }
  if (!token) return null; // no way to look up live; caller falls back to the id

  const profile = await fetchSlackProfile(token, userId); // may throw → tool surfaces a clean message
  if (db) await cacheProfile(db, accountId, userId, profile, now).catch(() => {});
  return profileLabel(profile);
}

/** The on-demand tool. The model passes the senderId it received in the turn input (or a bare user
 *  id); it gets back a name. Closed over db (cache) + the bot token (live lookup) — both trusted. */
export function userTools(db: D1Like | undefined, token: string | undefined): ToolDefinition[] {
  const resolveUser = defineTool({
    name: 'resolve_user',
    description:
      "Look up a person's display name from their Slack user id. The id is the `senderId` from the " +
      'dispatch input (e.g. "slack:T123:U456") or a bare id like "U456". Use this when you need to ' +
      'address someone by name or attribute who said something. Results are cached, so calling it ' +
      'repeatedly for the same person is cheap.',
    input: v.object({
      user: v.pipe(v.string(), v.description('The senderId ("slack:<team>:<user>") or a bare Slack user id ("U…").')),
    }),
    async run({ data: { user } }) {
      const id = String(user);
      const name = await resolveUserName(db, token, id).catch((e) => {
        throw new Error(`Couldn't resolve ${id}: ${(e as Error).message}`);
      });
      if (!name) return `No name available for ${id} (not a resolvable user id, or lookup unavailable).`;
      return name;
    },
  });
  return [resolveUser];
}
