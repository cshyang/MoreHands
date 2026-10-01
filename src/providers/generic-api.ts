// Generic "call_api" — the bet-on-intelligence path (ADR 0003, Test A result). ONE tool per
// connected provider: the model composes the REST call from its own knowledge, the broker injects
// the credential at the network boundary. Test A proved this passes cold through Tier 4 on GitHub.
//
// The generalization finding (ADR 0003, 2026-05-31): a single generic tool is NOT enough on its
// own for every provider. Two things vary per provider, so they live in a PROFILE here:
//   1. methodPolicy — GitHub's PAT may carry write scope, so generic GitHub is GET-only (writes go
//      through the v2b approval gate). Notion's token is provisioned READ-ONLY at Notion's side, so
//      isolation = the token's own scope and ALL methods are allowed — which matters because Notion
//      READS go through POST (/v1/search, /v1/databases/{id}/query). The HTTP method is NOT a
//      reliable read/write signal across providers; the profile decides.
//   2. crib — low-training-density / quirky providers need a few hundred tokens of hints (base URL,
//      required headers like Notion-Version, the handful of endpoints that matter). GitHub needs
//      almost none; Notion needs the version header it routinely forgets. The crib rides in the
//      tool DESCRIPTION (loads only when the tool exists, right where the model decides to call).

import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import { fetchWithTimeout, jsonMessageOrText } from './http';
import type { ToolCallRecorder, ToolCallStatus } from '../connections/audit';

export interface ProviderApiProfile {
  provider: string;
  /** API origin, no trailing slash. e.g. 'https://api.github.com'. */
  baseUrl: string;
  /** Auth headers built from the resolved secret (never logged, never in the prompt). */
  auth: (secret: string) => Record<string, string>;
  /** Always-sent headers a provider requires (e.g. Notion-Version). */
  staticHeaders?: Record<string, string>;
  /** 'get-only' refuses writes with a pointer to the (not-yet-wired) approval gate. 'all' trusts
   *  the token's own scope — use ONLY when the provisioned token is read-only at the provider.
   *  'get-post' (the generic-provider default) allows GET+POST — POST because many reads hide
   *  behind it (the Notion lesson) — but blocks the destructive verbs DELETE/PUT/PATCH. Method is
   *  a fence, not a guard: POST writes (GraphQL mutations…) pass; real write safety is the future
   *  approval gate. A per-connection config `methodPolicy` overrides in either direction. */
  methodPolicy: 'get-only' | 'get-post' | 'all';
  /** Provider hints injected into the tool description, computed from the connection's config. */
  crib: (config: Record<string, unknown>) => string;
}

const UA = 'morehands-agent';

export const PROVIDER_API_PROFILES: Record<string, ProviderApiProfile> = {
  github: {
    provider: 'github',
    baseUrl: 'https://api.github.com',
    auth: (s) => ({ authorization: `Bearer ${s}`, 'x-github-api-version': '2022-11-28', accept: 'application/vnd.github+json' }),
    methodPolicy: 'get-only',
    crib: (config) => {
      const repo = typeof config.repo === 'string' ? config.repo : undefined;
      return (
        'Base: https://api.github.com (well-known REST — compose paths from your knowledge). ' +
        (repo ? `Connected repo: ${repo} — use it as owner/name unless told otherwise. ` : '') +
        'Handy: /repos/{owner}/{repo}/issues?state=open · /contents/{path} · /languages · /contributors · /search/code?q=…'
      );
    },
  },
  tavily: {
    provider: 'tavily',
    baseUrl: 'https://api.tavily.com',
    auth: (s) => ({ authorization: `Bearer ${s}` }),
    // Search and extract are POST reads — the get-post default fits exactly; there are no
    // write endpoints to gate.
    methodPolicy: 'get-post',
    crib: () =>
      'Base: https://api.tavily.com — web search for CURRENT information (your training data is stale; search before ' +
      'answering questions about recent events, versions, prices, news). ' +
      'POST /search body {"query":"…","max_results":5,"search_depth":"basic"} — use "advanced" depth only when basic misses; ' +
      'add {"include_answer":true} for a synthesized answer alongside results. ' +
      'POST /extract body {"urls":["https://…"]} fetches page content for URLs worth reading in full. ' +
      'Results carry url/title/content — cite the urls in your reply.',
  },
  notion: {
    provider: 'notion',
    baseUrl: 'https://api.notion.com',
    auth: (s) => ({ authorization: `Bearer ${s}` }),
    // Notion requires a version header on EVERY request; the model omits it unless told.
    staticHeaders: { 'Notion-Version': '2022-06-28' },
    // 'all': the test token is provisioned read-only in Notion, so even a stray POST write is
    // rejected provider-side. This also lets the genuine READS (search/query) through, which POST.
    methodPolicy: 'all',
    crib: () =>
      'Base: https://api.notion.com. Auth + Notion-Version header are added for you. ' +
      'Note: Notion READS often use POST. Key endpoints: ' +
      'POST /v1/search (body {} lists everything shared with the integration) · ' +
      'GET /v1/users/me (the integration bot) · GET /v1/users · ' +
      'GET /v1/pages/{page_id} · GET /v1/blocks/{block_id}/children (a page\'s content) · ' +
      'GET /v1/databases/{database_id} (schema) · POST /v1/databases/{database_id}/query (body {} for all rows). ' +
      'A page/database is only visible if it was shared with the integration.',
  },
};

// ── Dynamic profiles (generic Nango providers) ─────────────────────────────────────────────────
// Providers WITHOUT a hand-written entry above get a profile built at runtime from the connection's
// persisted `config.api` (fetched from Nango's catalog at connect time — see fetchProviderApiSpec).
// Direct calls when the auth is plain Bearer; everything else relays through Nango's proxy, which
// resolves exotic auth (API keys in query params, templated domains) from its own catalog.

interface PersistedApiSpec {
  baseUrl?: string;
  headers?: Record<string, string>;
  authMode?: string;
  docs?: string;
}

function persistedApiSpec(config: Record<string, unknown>): PersistedApiSpec | null {
  const api = config.api;
  return api && typeof api === 'object' && !Array.isArray(api) ? (api as PersistedApiSpec) : null;
}

const METHOD_POLICIES = new Set(['get-only', 'get-post', 'all']);

/** Per-connection override: config.methodPolicy (admin-written, never agent-written) beats the
 *  profile default in either direction. */
export function effectiveMethodPolicy(profile: ProviderApiProfile, config: Record<string, unknown>): ProviderApiProfile['methodPolicy'] {
  const override = config.methodPolicy;
  return typeof override === 'string' && METHOD_POLICIES.has(override) ? (override as ProviderApiProfile['methodPolicy']) : profile.methodPolicy;
}

/** Build a DIRECT-call profile for a generic provider from its persisted Nango spec. Returns null
 *  unless the auth is OAUTH2 (plain Bearer) and the base URL is concrete — callers then fall back
 *  to nangoProxyProfile. No crib: the bet-on-intelligence path, the model knows popular APIs. */
export function dynamicApiProfile(provider: string, config: Record<string, unknown>): ProviderApiProfile | null {
  const spec = persistedApiSpec(config);
  if (!spec?.baseUrl || spec.authMode !== 'OAUTH2') return null;
  const baseUrl = spec.baseUrl;
  const docs = spec.docs;
  return {
    provider,
    baseUrl,
    auth: (s) => ({ authorization: `Bearer ${s}` }),
    ...(spec.headers && Object.keys(spec.headers).length ? { staticHeaders: spec.headers } : {}),
    methodPolicy: 'get-post',
    crib: () => `Base: ${baseUrl} (compose paths from your knowledge of the ${provider} API).${docs ? ` Docs: ${docs}` : ''}`,
  };
}

/** Build a PROXY profile: every call relays through api.nango.dev/proxy, where Nango injects the
 *  credential and base URL from its catalog. The `secret` passed to genericApiTool with this
 *  profile is the NANGO platform key, NOT a provider token. Fallback for non-Bearer auth. */
export function nangoProxyProfile(provider: string, routing: { connectionRef: string; providerConfigKey: string }): ProviderApiProfile {
  return {
    provider,
    baseUrl: 'https://api.nango.dev/proxy',
    auth: (s) => ({ authorization: `Bearer ${s}` }),
    staticHeaders: { 'provider-config-key': routing.providerConfigKey, 'connection-id': routing.connectionRef },
    methodPolicy: 'get-post',
    crib: () =>
      `Calls are relayed through Nango's proxy, which adds the ${provider} credential and base URL for you. ` +
      `path is the ${provider} API path (after its own base origin), composed from your knowledge of that API.`,
  };
}

const MAX_BODY = 8000; // keep tool results small for the chat context
// Per-call fetch ceiling. A DO turn holds the input gate while it runs; if a turn drags past ~30s,
// a concurrent hibernation-wake / alarm runs partyserver's blockConcurrencyWhile(onStart), which
// waits for the turn to drain, times out, and resets the DO mid-turn → the agent goes silent. An
// uncapped fetch is the sharpest contributor, so bound every external call well under that budget.
const FETCH_TIMEOUT_MS = 12_000;

/** The generic call tool for one connected provider. `secret` is the resolved credential; `config`
 *  is the connection's non-secret config (e.g. {repo}). Returns ONE tool named `<provider>_call_api`.
 *  `audit` (optional) gets one record per call — every outcome, including policy refusals: a blocked
 *  DELETE is exactly the injection-probe trace the log exists to catch. */
export function genericApiTool(
  profile: ProviderApiProfile,
  secret: string | (() => Promise<string>),
  config: Record<string, unknown>,
  audit?: ToolCallRecorder,
): ToolDefinition {
  const policy = effectiveMethodPolicy(profile, config);
  const getOnly = policy === 'get-only';
  const methodNote =
    policy === 'get-only'
      ? 'Read-only for now: only method "GET" is allowed (writes need human approval and are not wired yet). '
      : policy === 'get-post'
        ? 'GET and POST are allowed (some reads use POST); DELETE/PUT/PATCH are blocked pending human approval. '
        : 'Reads and writes share this tool; some reads use POST. ';
  return defineTool({
    name: `${profile.provider}_call_api`,
    description:
      `Call the ${profile.provider} API directly — you compose the request from your knowledge of the API. ` +
      methodNote +
      'path is the API path after the base origin, beginning with "/", including any query string. ' +
      'Authentication is handled for you — never include tokens. ' +
      profile.crib(config),
    input: v.object({
      method: v.pipe(v.string(), v.description(getOnly ? 'HTTP method. Only "GET" is permitted right now.' : 'HTTP method (GET, POST, …).')),
      path: v.pipe(v.string(), v.description('API path beginning with "/", including any query string.')),
      body: v.optional(v.pipe(v.string(), v.description('Request body as a JSON string, for non-GET calls (e.g. a Notion query filter). Omit for GET.'))),
    }),
    async run({ data: { method, path, body } }) {
      const m = String(method).toUpperCase();
      const p = String(path).startsWith('/') ? String(path) : `/${String(path)}`;
      if (getOnly && m !== 'GET') {
        audit?.({ provider: profile.provider, method: m, path: p, status: 'blocked', durationMs: 0 });
        throw new Error(`Only GET is allowed for ${profile.provider} via ${profile.provider}_call_api; "${m}" is a write and needs approval (not wired yet).`);
      }
      if (policy === 'get-post' && m !== 'GET' && m !== 'POST') {
        audit?.({ provider: profile.provider, method: m, path: p, status: 'blocked', durationMs: 0 });
        throw new Error(`"${m}" is blocked for ${profile.provider} via ${profile.provider}_call_api — destructive verbs need an operator to set methodPolicy:"all" on this connection.`);
      }
      // Resolve the credential at the network boundary: a literal Worker secret, or a lazy Nango
      // token fetched (and per-turn-memoized) only now that a call is actually being made.
      const resolvedSecret = typeof secret === 'function' ? await secret() : secret;
      const headers: Record<string, string> = {
        ...profile.auth(resolvedSecret),
        ...(profile.staticHeaders ?? {}),
        'user-agent': UA,
      };
      if (!headers.accept) headers.accept = 'application/json';
      const init: RequestInit = { method: m, headers };
      if (body != null && body !== '' && m !== 'GET') {
        headers['content-type'] = 'application/json';
        init.body = String(body);
      }
      const started = Date.now();
      let status: ToolCallStatus = 'fetch_error'; // a throw out of fetchWithTimeout leaves this standing
      try {
        const res = await fetchWithTimeout(`${profile.baseUrl}${p}`, init, {
          timeoutMs: FETCH_TIMEOUT_MS,
          timeoutMessage: `${profile.provider} request timed out after ${FETCH_TIMEOUT_MS}ms (${m} ${p}). Try a narrower call.`,
          failurePrefix: `${profile.provider} request failed`,
        });
        status = res.ok ? 'success' : 'http_error';
        const text = await res.text();
        if (!res.ok) {
          const msg = jsonMessageOrText(text, 300);
          throw new Error(`${profile.provider} ${res.status}: ${msg}`);
        }
        const out = text ?? '';
        return out.length > MAX_BODY ? out.slice(0, MAX_BODY) + '\n…(truncated)' : out;
      } finally {
        audit?.({ provider: profile.provider, method: m, path: p, status, durationMs: Date.now() - started });
      }
    },
  });
}
