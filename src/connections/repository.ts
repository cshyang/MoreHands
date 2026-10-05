// The connection broker (ADR 0003). Owns per-project connection metadata and credential resolution.
// Vendors are swappable behind resolveConnection — the agent, gating, and approval flow don't change
// as backends evolve.
//
// v2a backend = WORKER SECRET REFERENCES, identical to how the Slack bot token already works
// (binding.transportTokenRef → env[ref]). A connection is declared in the binding as
// {provider, tokenRef, config}; the actual secret lives as a Worker secret set with
// `wrangler secret put`, never in code, D1, the prompt, or the model. This deliberately is NOT
// a self-managed vault (no master key, no admin route, no ciphertext column): for an operator
// provisioning a handful of projects, a Worker secret is simpler AND no less secure at rest
// (CF KMS, write-only) than hand-rolled encrypted D1.
//
// Future backends slot behind the SAME resolveConnection signature:
//   - OAuth providers (Google Ads, Meta) → a Composio/Nango account-ref (vendor holds the token)
//   - static-key SELF-SERVICE (a client pastes a key at runtime) → encrypted D1 or a managed
//     vault — built only when that pain is real (the crypto.ts version lives in git history).

import type { Binding, ConnectionSpec } from '../project/bindings';
import type { D1Like } from '../skills/repository';
import { fetchToken } from '../providers/nango';
import { connectionProviderConfigKey } from './integrations';

export interface ConnectionState {
  provider: string;
  status: 'connected' | 'not_connected';
  config: Record<string, unknown>;
  /** Nango connection id (non-secret) — present on managed-OAuth rows; routes the proxy fallback. */
  connectionRef?: string;
}

/** Derive each declared connection's state from its specs + whether its Worker secret is present.
 *  Drives gating + the prompt block. Pure over specs (the initializer resolves specs first via
 *  loadConnectionSpecs). Never exposes the secret. A connectionRef row reads as connected once
 *  NANGO_SECRET_KEY is present (the managed-OAuth backend; the token is fetched lazily in the tool). */
export function connectionState(specs: ConnectionSpec[], env: Record<string, unknown>): ConnectionState[] {
  const nangoKey = env.NANGO_SECRET_KEY;
  const hasNangoPlatform = typeof nangoKey === 'string' && !!nangoKey;
  return specs.map((s) => {
    const token = s.tokenRef ? env[s.tokenRef] : undefined;
    const hasWorkerSecret = typeof token === 'string' && !!token;
    // Managed-OAuth (Nango): a connection_ref means a connection exists; the platform key means we
    // can fetch its token. Both → connected (the token itself is fetched lazily in the tool).
    const hasNango = !!s.connectionRef && hasNangoPlatform;
    return {
      provider: s.provider,
      status: hasWorkerSecret || hasNango ? 'connected' : 'not_connected',
      config: s.config ?? {},
      ...(s.connectionRef ? { connectionRef: s.connectionRef } : {}),
    };
  });
}

/** A resolved credential for one provider. `secret` is EITHER a literal Worker-secret string
 *  (operator/static backend) OR a lazy, per-turn-memoized token fetch (managed-OAuth/Nango). The
 *  generic call tool resolves it at the network boundary, so a Nango token is fetched only when a
 *  tool actually runs — never in the DO initializer. */
export interface ResolvedConnection {
  secret: string | (() => Promise<string>);
  config: Record<string, unknown>;
}

/** Resolve a provider's credential from specs, or null if not declared / unusable. The ONE
 *  resolution path (the swappable seam). Worker-secret backend → a literal string; managed-OAuth
 *  (Nango) backend → a lazy thunk that fetches a live token on first call and memoizes it for the
 *  rest of the turn. `deps.fetchToken` is injectable for tests. */
export function resolveConnection(
  specs: ConnectionSpec[],
  env: Record<string, unknown>,
  provider: string,
  deps: { fetchToken?: typeof fetchToken } = {},
): ResolvedConnection | null {
  const spec = specs.find((s) => s.provider === provider);
  if (!spec) return null;

  // Worker-secret backend (operator/static): a literal secret present in env.
  if (spec.tokenRef) {
    const token = env[spec.tokenRef];
    if (typeof token === 'string' && token) return { secret: token, config: spec.config ?? {} };
  }

  // Managed-OAuth backend (Nango): connection_ref + platform key → a lazy, per-turn-memoized token
  // fetch. Memoizing the PROMISE dedupes concurrent tool calls AND caps a multi-call turn at ONE
  // Nango round-trip (keeps us off the ~30s DO-turn wall). The token is never stored at rest.
  const nangoKey = env.NANGO_SECRET_KEY;
  if (spec.connectionRef && typeof nangoKey === 'string' && nangoKey) {
    const fetchTok = deps.fetchToken ?? fetchToken;
    const secretKey = nangoKey;
    const connectionId = spec.connectionRef;
    const providerConfigKey = connectionProviderConfigKey(provider, spec.config ?? {});
    // `??=` caches the PROMISE on first call. A REJECTED promise stays cached too — so a failed token
    // fetch is NOT retried within this turn (every later secret() call this turn gets the same
    // rejection). Intentional: one Nango hiccup shouldn't trigger a retry storm across a multi-call
    // turn. The credential is rebuilt fresh by the DO initializer every turn, so the next turn retries.
    let cached: Promise<string> | undefined;
    const secret = () => (cached ??= fetchTok({ secretKey, connectionId, providerConfigKey }));
    return { secret, config: spec.config ?? {} };
  }

  return null;
}

/** One-call convenience over the broker: load a project's specs, resolve `provider`, and return a live
 *  token string (awaiting the Nango thunk when present), or null if not connected. The dispatch path
 *  (provider 'github') and the Linear reply path both use this so neither re-implements the
 *  specs→resolve→await-thunk dance. Auth-mode-agnostic: oauth/pat/app all surface as a token string. */
export async function resolveProviderToken(
  db: D1Like | undefined,
  binding: Binding,
  env: Record<string, unknown>,
  provider: string,
  deps: { fetchToken?: typeof fetchToken } = {},
): Promise<string | null> {
  const specs = await loadConnectionSpecs(db, binding);
  const resolved = resolveConnection(specs, env, provider, deps);
  if (!resolved) return null;
  return typeof resolved.secret === 'string' ? resolved.secret : await resolved.secret();
}

// ── D1 metadata layer (operator-provisioned, no redeploy) ───────────────────────────────────────

export interface ConnectionRecord {
  provider: string;
  tokenRef?: string;
  connectionRef?: string;
  config: Record<string, unknown>;
  status: 'active' | 'disabled';
}

/** Live connection rows for a project (metadata only — never a secret). */
export async function loadConnections(db: D1Like, projectId: string): Promise<ConnectionRecord[]> {
  const { results } = await db
    .prepare('SELECT provider, token_ref, connection_ref, config_json, status FROM connections WHERE project_id=?')
    .bind(projectId)
    .all<{ provider: string; token_ref: string | null; connection_ref: string | null; config_json: string | null; status: string }>();
  return (results ?? []).map((r) => ({
    provider: r.provider,
    tokenRef: r.token_ref ?? undefined,
    connectionRef: r.connection_ref ?? undefined,
    config: r.config_json ? (JSON.parse(r.config_json) as Record<string, unknown>) : {},
    status: r.status === 'disabled' ? 'disabled' : 'active',
  }));
}

/** The effective connection specs for a project: bindings.ts `connections` is a CODE SEED; live D1
 *  rows are the source of truth — they add/override by provider, and status='disabled' removes a
 *  seeded one. This is what lets an operator add a connection with no redeploy. A D1 hiccup falls
 *  back to the seed so a transient DB error can't strip a working connection. */
export async function loadConnectionSpecs(db: D1Like | undefined, binding: Binding,
  options?: { strictDb?: boolean }): Promise<ConnectionSpec[]> {
  const seed = binding.connections ?? [];
  if (!db) return seed;
  const rows = await loadConnections(db, binding.projectId).catch(error => {
    if (options?.strictDb) throw error;
    return null;
  });
  if (!rows) return seed; // DB hiccup → keep the seed rather than dropping connections
  const byProvider = new Map<string, ConnectionSpec>();
  for (const s of seed) byProvider.set(s.provider, s);
  for (const r of rows) {
    if (r.status === 'disabled') {
      byProvider.delete(r.provider);
      continue;
    }
    byProvider.set(r.provider, { provider: r.provider, tokenRef: r.tokenRef, connectionRef: r.connectionRef, config: r.config });
  }
  return [...byProvider.values()];
}

export interface UpsertConnectionInput {
  projectId: string;
  provider: string;
  tokenRef?: string;
  connectionRef?: string;
  config?: Record<string, unknown>;
  status?: 'active' | 'disabled';
  createdBy?: string;
}

/** OPERATOR write (route-guarded, never the agent). Upsert a connection's metadata. The secret it
 *  references must be set separately via `wrangler secret put` — this never receives or stores it. */
export async function upsertConnection(db: D1Like, input: UpsertConnectionInput): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO connections(project_id, provider, token_ref, connection_ref, config_json, status, created_by, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(project_id, provider) DO UPDATE SET
         token_ref=excluded.token_ref,
         connection_ref=excluded.connection_ref,
         config_json=excluded.config_json,
         status=excluded.status,
         updated_at=excluded.updated_at`,
    )
    .bind(
      input.projectId,
      input.provider,
      input.tokenRef ?? null,
      input.connectionRef ?? null,
      input.config ? JSON.stringify(input.config) : null,
      input.status ?? 'active',
      input.createdBy ?? null,
      now,
      now,
    )
    .run();
}

/** The "✅ connected" line the gateway posts to the channel when a Nango connection lands. The
 *  webhook has no conversation thread to reply into, so the GATEWAY (not the agent) posts this — a
 *  deterministic confirmation that doesn't depend on the model choosing to reply. The tools attach on
 *  the channel's next turn (computed fresh from D1), which is what this message tells the user. */
export function connectedNotice(provider: string): string {
  return `✅ ${provider} connected — ask me to use it anytime (it'll be ready on your next message).`;
}

/** The "🔌 disconnected" line the gateway posts when a Nango connection is removed. Posted only when a
 *  row was actually disabled (so we don't announce a delete for a connection we never had). */
export function disconnectedNotice(provider: string): string {
  return `🔌 ${provider} disconnected — its tools are no longer available. Reconnect anytime by asking me.`;
}

/** Disable the connection row matching a Nango connection_ref (the deletion path). Targets by
 *  connection_ref — the only field guaranteed present on a deletion webhook — NOT by project/provider.
 *  Returns {projectId, provider} of the disabled row (so the gateway can post the notice to the right
 *  channel), or null if no row matched (already gone / never ours). Flipping status to 'disabled'
 *  makes loadConnectionSpecs drop it → the provider's tools disappear next turn. We disable rather
 *  than DELETE so the row stays an audit trail and a re-connect cleanly overwrites it. */
export async function disableConnectionByRef(
  db: D1Like,
  connectionRef: string,
): Promise<{ projectId: string; provider: string } | null> {
  const row = await db
    .prepare('SELECT project_id, provider FROM connections WHERE connection_ref=? AND status=\'active\'')
    .bind(connectionRef)
    .first<{ project_id: string; provider: string }>();
  if (!row) return null;
  await db
    .prepare('UPDATE connections SET status=\'disabled\', updated_at=? WHERE connection_ref=?')
    .bind(Date.now(), connectionRef)
    .run();
  return { projectId: row.project_id, provider: row.provider };
}
