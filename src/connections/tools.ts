import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import { dynamicApiProfile, genericApiTool, nangoProxyProfile, PROVIDER_API_PROFILES } from '../providers/generic-api';
import { disconnectedNotice, disableConnectionByRef, loadConnections, type ConnectionState, type ResolvedConnection } from './repository';
import { githubReadTools } from '../providers/github';
import { deleteConnection, listIntegrations, startConnectSession } from '../providers/nango';
import { PROVIDER_CATALOG, providerUsesGenericApi, type ProviderCatalogEntry } from './catalog';
import type { D1Like } from '../skills/repository';
import type { ToolCallRecorder } from './audit';
import {
  connectionProviderConfigKey,
  nangoIntegrationKey,
  normalizeAuthMode,
  normalizeGithubRepo,
  supportedAuthModes,
  type ConnectionAuthMode,
  type NangoIntegrationKeys,
} from './integrations';

// The CONNECTIONS prompt block (mirrors the skills catalog injection). Tells the agent what it
// can reach and what is connectable but not yet wired by an operator. `available` is the live
// list of integrations enabled in the workspace's Nango project — without it the agent only
// knows the curated catalog and wrongly tells people a perfectly connectable service (e.g.
// gmail) isn't supported.
export function connectionsBlock(
  state: ConnectionState[],
  catalog: ProviderCatalogEntry[],
  canRequest = false,
  available: Array<{ uniqueKey: string; displayName: string }> = [],
): string {
  const byProvider = new Map(state.map((s) => [s.provider, s]));
  const lines = catalog.map((c) => {
    const s = byProvider.get(c.provider);
    if (s?.status === 'connected') {
      const detail = connectionDetail(c.provider, s.config);
      return `  ✅ ${c.provider} (connected${detail ? `: ${detail}` : ''}) — ${c.summary}`;
    }
    return `  ⚪ ${c.provider} (not connected) — ${c.summary}`;
  });
  // Generic Nango providers: connected but not in the curated catalog — still listed, still usable.
  const curated = new Set(catalog.map((c) => c.provider));
  for (const s of state) {
    if (s.status === 'connected' && !curated.has(s.provider)) {
      lines.push(`  ✅ ${s.provider} (connected) — generic API access via ${s.provider}_call_api`);
    }
  }
  // Enabled-in-Nango integrations beyond the catalog: connectable RIGHT NOW via request_connection.
  // Auth-mode variants of curated providers (github-app, github-pat) fold into their base line.
  const shown = new Set([...curated, ...state.map((s) => s.provider)]);
  for (const i of available) {
    if (shown.has(i.uniqueKey) || [...curated].some((p) => i.uniqueKey.startsWith(`${p}-`))) continue;
    shown.add(i.uniqueKey);
    const label = i.displayName && i.displayName !== i.uniqueKey ? ` (${i.displayName})` : '';
    lines.push(`  ⚪ ${i.uniqueKey}${label} (not connected; enabled in Nango) — request_connection "${i.uniqueKey}" to connect`);
  }
  const intro = canRequest
    ? 'External services you can reach. Connected ones expose tools you can call now. For one that is NOT ' +
      'connected, call request_connection with the provider name — you get a secure link to share; the ' +
      'person authorizes off-Slack (you never see the credential) and that provider\'s tools appear ' +
      'automatically once they finish. For GitHub, prefer authMode "app" (authorize the GitHub App; it acts ' +
      'on the person\'s behalf with short-lived, repo-scoped tokens); "oauth" (workspace-wide) or "pat" plus repo "owner/name" (single repo) also work.'
    : 'External services you can reach. Connected ones expose tools you can call now; the rest must be ' +
      'wired by an operator first (mention that you need it — you cannot connect it yourself).';
  return (
    'YOUR CONNECTIONS\n' +
    intro +
    '\n' +
    lines.join('\n') +
    '\nKeep API work tight: reach the answer in as few calls as you can (ideally 1–3). Do NOT fan out ' +
    'to read every result of a search/list — fetch the list, then read details only for what the user ' +
    'actually asked about. Long chains of calls can stall the turn.'
  );
}

function connectionDetail(provider: string, config: Record<string, unknown>): string {
  const parts: string[] = [];
  if (provider === 'github') {
    const mode = typeof config.authMode === 'string' ? config.authMode : undefined;
    const repo = typeof config.repo === 'string' ? config.repo : undefined;
    if (mode) parts.push(mode.toUpperCase());
    if (repo) parts.push(`repo ${repo}`);
  }
  return parts.join(', ');
}

/** Tools contributed by connections, gated on state (ADR D6): the initializer pushes these only
 *  for connected providers. v2a = READS only. The github_create_issue PROPOSE tool is v2b — it
 *  ships together with the gateway executor + Block Kit approval + hard-gate tests, so we don't
 *  leave a propose tool whose other half doesn't exist. `secrets` maps provider → resolved
 *  {secret, config}. */
export function connectionTools(
  state: ConnectionState[],
  secrets: Record<string, ResolvedConnection>,
  /** Nango platform key — routes the proxy-fallback profile for generic providers. Optional: without
   *  it (or a connectionRef), a generic provider without a direct-call spec is simply toolless. */
  nangoSecretKey?: string,
  /** Project-bound tool-call recorder (audit log) — every outbound provider call lands one row. */
  audit?: ToolCallRecorder,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  for (const s of state) {
    if (s.status !== 'connected') continue;
    const creds = secrets[s.provider];
    if (!creds) continue;

    // Generic path (default unless a provider has typed tools and isn't opted into generic): one
    // <provider>_call_api tool driven by the provider's API profile. The model composes the call.
    // Profile precedence: hand-written (cribs, tuned policy) → dynamic direct (persisted Nango spec,
    // Bearer auth) → Nango proxy (exotic auth; Nango resolves it from its own catalog per call).
    const profile = PROVIDER_API_PROFILES[s.provider] ?? dynamicApiProfile(s.provider, creds.config);
    // A Nango-backed credential is a lazy thunk; the typed tools (githubReadTools) take a string PAT
    // and cannot consume it. Route any thunk secret through the generic call_api path (genericApiTool
    // resolves the thunk at call time).
    const isLazy = typeof creds.secret === 'function';
    if ((providerUsesGenericApi(s.provider, creds.config) || isLazy) && profile) {
      tools.push(genericApiTool(profile, creds.secret, creds.config, audit));
      continue;
    }
    if (!profile && nangoSecretKey && s.connectionRef) {
      const proxy = nangoProxyProfile(s.provider, { connectionRef: s.connectionRef, providerConfigKey: connectionProviderConfigKey(s.provider, creds.config) });
      // The proxy authenticates with the NANGO key; the provider credential never touches us.
      tools.push(genericApiTool(proxy, nangoSecretKey, creds.config, audit));
      continue;
    }

    // Typed fallback (github, apiMode !== 'generic'): the proven v2a read tools, untouched. Only a
    // string-secret connection reaches here (thunks took the generic path above), so the cast is safe.
    if (s.provider === 'github') {
      const repo = typeof creds.config.repo === 'string' ? creds.config.repo : undefined;
      tools.push(...githubReadTools(creds.secret as string, repo, audit));
      // v2b plugs the github_create_issue propose-tool in here.
    }
  }

  return tools;
}

/** The agent's connect request (Component 3). Returns a tool that starts a Nango Connect session for
 *  THIS channel and hands back the magic link for the agent to share. THE STRUCTURAL WALL: there is
 *  no parameter that accepts a secret — a prompt-injected agent has no tool to receive or store a
 *  token. Gated to the provider catalog (the agent can't request an arbitrary provider).
 *  `deps.startConnectSession` is injectable for tests. */
export function requestConnectionTool(
  args: {
    nangoSecretKey: string;
    projectId: string;
    catalog?: ProviderCatalogEntry[];
    nangoIntegrationKeys?: NangoIntegrationKeys;
    /** Unique keys of the integrations actually enabled in this workspace's Nango project. When
     *  provided, a catalog provider whose resolved key isn't here fails with a clear message
     *  instead of a cryptic Nango 400 ("Integration does not exist"). Undefined → no gating. */
    enabledIntegrationKeys?: string[];
  },
  deps: {
    startConnectSession?: typeof startConnectSession;
    listIntegrations?: typeof listIntegrations;
    /** Post the connect link straight into the thread. When wired, the high-entropy link never
     *  enters the model's tool result — so the model can't stall reproducing it token-by-token
     *  (the connection-turn hang). Returns false if it couldn't post; we then fall back to handing
     *  the link to the model so it's never lost. */
    postConnectionLink?: (input: { conversationId: string; text: string }) => Promise<boolean>;
  } = {},
): ToolDefinition {
  const catalog = args.catalog ?? PROVIDER_CATALOG;
  const allowed = catalog.map((c) => c.provider);
  const start = deps.startConnectSession ?? startConnectSession;
  const listEnabled = deps.listIntegrations ?? listIntegrations;

  // Deliver the link without making the model reproduce it. Posts directly to the thread when we
  // can; otherwise returns the link in-result (legacy path: tests, or a call with no conversationId).
  const deliver = async (copy: string, provider: string, conversationId: string | undefined): Promise<string> => {
    const conv = conversationId ? String(conversationId) : '';
    if (deps.postConnectionLink && conv) {
      const posted = await deps.postConnectionLink({ conversationId: conv, text: copy }).catch(() => false);
      if (posted) {
        return `I posted the ${provider} connection link in this thread. Tell them to click it to authorize — do NOT repeat the link yourself; it is already shared.`;
      }
    }
    return copy;
  };
  return defineTool({
    name: 'request_connection',
    description:
      'Start connecting an external service for THIS channel. Pass the provider name; you get back a ' +
      'secure authorization link to share with the person. They click it and authorize off-Slack — you ' +
      "NEVER receive or handle the credential. Once they finish, that provider's tools appear " +
      `automatically. For GitHub, prefer authMode "app" (authorize the GitHub App; it acts on the person's behalf with short-lived, repo-scoped tokens); "oauth" and "pat" (with repo "owner/name") also work. Known providers: ${allowed.join(', ')} — but ANY integration enabled in the workspace's Nango project is connectable; pass its name and it is checked live.`,
    input: v.object({
      provider: v.pipe(v.string(), v.description(`The provider to connect, e.g. ${allowed.join(', ')}, or any other integration enabled in Nango.`)),
      authMode: v.optional(v.pipe(v.string(), v.description('Optional auth mode. For GitHub: "app" (GitHub App, acts on the person\'s behalf, recommended), "oauth" (default), or "pat". Other providers use "oauth".'))),
      repo: v.optional(v.pipe(v.string(), v.description('Optional GitHub owner/name. Required when provider="github" and authMode="pat".'))),
      conversationId: v.optional(v.pipe(v.string(), v.description('Copy from the current Dispatch Input (same as your reply) so I can post the link straight into this thread.'))),
    }),
    async run({ data: { provider, authMode, repo, conversationId } }) {
      const p = String(provider).toLowerCase();
      if (!allowed.includes(p)) {
        // Not curated — accept anything actually enabled in Nango (the dashboard IS the catalog).
        const enabled = await listEnabled({ secretKey: args.nangoSecretKey }).catch(() => []);
        const match = enabled.find((i) => i.uniqueKey.toLowerCase() === p || i.provider.toLowerCase() === p);
        if (!match) {
          const names = enabled.map((i) => i.uniqueKey).join(', ');
          return `Cannot connect "${provider}" — not enabled in this workspace's Nango project. ${names ? `Enabled: ${names}. ` : ''}An operator can enable it in the Nango dashboard first.`;
        }
        const { connectLink } = await start({
          secretKey: args.nangoSecretKey,
          endUserId: args.projectId,
          integrationId: match.uniqueKey,
          tags: { provider: p, auth_mode: 'oauth' },
        });
        return deliver(connectionRequestCopy(p, 'oauth', connectLink, null), p, conversationId);
      }
      const mode = normalizeAuthMode(p, authMode);
      if (!mode) {
        return `Cannot connect ${p} with authMode "${authMode}" — supported modes: ${supportedAuthModes(p).join(', ')}.`;
      }
      const normalizedRepo = repo == null || repo === '' ? null : normalizeGithubRepo(repo);
      if (p === 'github' && mode === 'pat' && !normalizedRepo) {
        return 'repo is required for a GitHub PAT connection. Use owner/name, for example acme/widgets.';
      }
      if (p === 'github' && repo && !normalizedRepo) {
        return 'repo must be a GitHub owner/name value, for example acme/widgets.';
      }
      const integrationId = nangoIntegrationKey(p, mode as ConnectionAuthMode, args.nangoIntegrationKeys);
      // Gate on the live enabled list (when known): a catalog provider whose key isn't actually
      // set up in Nango otherwise returns a cryptic "Integration does not exist" 400. Tell the
      // agent what IS enabled so it can fall back to a working mode instead.
      const enabledKeys = args.enabledIntegrationKeys;
      if (enabledKeys && enabledKeys.length && !enabledKeys.includes(integrationId)) {
        const opts = enabledKeys.filter((k) => k === p || k.startsWith(`${p}-`) || k.startsWith(`${p}_`));
        return (
          `Can't connect ${p} via "${mode}": the "${integrationId}" integration isn't enabled in this workspace's Nango project.` +
          (opts.length ? ` Enabled ${p} integration(s): ${opts.join(', ')} — try a matching auth mode.` : '') +
          ' An operator can add it in the Nango dashboard.'
        );
      }
      const tags: Record<string, string> = { provider: p, auth_mode: mode };
      if (normalizedRepo) tags.repo = normalizedRepo;
      const { connectLink } = await start({ secretKey: args.nangoSecretKey, endUserId: args.projectId, integrationId, tags });
      return deliver(connectionRequestCopy(p, mode as ConnectionAuthMode, connectLink, normalizedRepo), p, conversationId);
    },
  });
}

function connectionRequestCopy(provider: string, mode: ConnectionAuthMode, connectLink: string, repo: string | null): string {
  if (provider === 'github' && mode === 'pat') {
    return (
      `Connect GitHub PAT for repo ${repo}:\n${connectLink}\n\n` +
      'Use this when access should stay limited to that repo. Paste the PAT only on the secure connection page; I never see it.'
    );
  }
  if (provider === 'github' && mode === 'app') {
    return (
      `Authorize the MoreHands GitHub App:\n${connectLink}\n\n` +
      'On the GitHub install/authorize screen, pick the repos to grant. The app then acts on your behalf ' +
      'with short-lived, repo-scoped tokens — bounded by what you grant (no personal access token to manage).'
    );
  }
  if (provider === 'github') {
    return (
      `Connect GitHub with OAuth:\n${connectLink}\n\n` +
      'Use this for normal workspace setup. If you only want one repo, ask me for a repo-scoped PAT link instead.'
    );
  }
  if (provider === 'linear') {
    return (
      `Connect Linear:\n${connectLink}\n\n` +
      'After authorization, I can read Linear context and react to Run Agent state changes once an admin activates a route.'
    );
  }
  const label = provider.charAt(0).toUpperCase() + provider.slice(1);
  return `Connect ${label}:\n${connectLink}\n\nAuthorize on the secure connection page; I never see the credential.`;
}

/** The agent's disconnect tool (Component 3, in-Slack revoke — the only disconnect path a non-operator
 *  Tester has; the Nango dashboard is operator-only and dashboard-delete fires no webhook). Looks up
 *  THIS channel's connection_ref, revokes it at Nango (DELETE — real teardown, token revoked at the
 *  provider), then disables the local row so the provider's tools vanish next turn. No secret param —
 *  same structural wall as request_connection. Disconnect is the least-dangerous write (worst case:
 *  reconnect), so it's agent-callable without an approval gate (unlike a future github_create_issue).
 *  `deps.deleteConnection` is injectable for tests. */
export function disconnectConnectionTool(
  args: { nangoSecretKey: string; projectId: string; db: D1Like; catalog?: ProviderCatalogEntry[] },
  deps: { deleteConnection?: typeof deleteConnection } = {},
): ToolDefinition {
  const catalog = args.catalog ?? PROVIDER_CATALOG;
  const allowed = catalog.map((c) => c.provider);
  const del = deps.deleteConnection ?? deleteConnection;
  return defineTool({
    name: 'disconnect_connection',
    description:
      'Disconnect an external service from THIS channel — revokes access and removes its tools. Pass ' +
      'the provider name. Use when the user asks to disconnect, remove, revoke, or unlink a connection. ' +
      `Works for ANY connected provider (e.g. ${allowed.join(', ')}).`,
    input: v.object({
      provider: v.pipe(v.string(), v.description('The provider to disconnect — any currently connected provider name.')),
    }),
    async run({ data: { provider } }) {
      const p = String(provider).toLowerCase();
      // Find this channel's live connection_ref for the provider (managed-OAuth rows carry it).
      const rows = await loadConnections(args.db, args.projectId).catch(() => []);
      const row = rows.find((r) => r.provider === p && r.status === 'active' && r.connectionRef);
      if (!row || !row.connectionRef) {
        return `${p} isn't connected to this channel — nothing to disconnect.`;
      }
      // Revoke at Nango first (real teardown; 404 = already gone = fine), then disable locally so the
      // tools disappear next turn. If the Nango call hard-fails (non-404), surface it rather than
      // claim success while the token still lives at the vendor.
      try {
        await del({ secretKey: args.nangoSecretKey, connectionId: row.connectionRef, providerConfigKey: connectionProviderConfigKey(p, row.config) });
      } catch (e) {
        return `Couldn't fully disconnect ${p}: ${e instanceof Error ? e.message : 'error'}. Nothing was changed — try again.`;
      }
      await disableConnectionByRef(args.db, row.connectionRef);
      return disconnectedNotice(p);
    },
  });
}
