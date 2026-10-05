import type { ToolDefinition } from '@flue/runtime';
import type { Binding, ConnectionSpec } from '../project/bindings';
import { connectionState, loadConnectionSpecs, resolveConnection, type ConnectionState, type ResolvedConnection } from './repository';
import {
  connectionTools,
  connectionsBlock as renderConnectionsBlock,
  disconnectConnectionTool,
  requestConnectionTool,
} from './tools';
import { PROVIDER_CATALOG, type ProviderCatalogEntry } from './catalog';
import { toolCallRecorder } from './audit';
import type { D1Like } from '../skills/repository';
import { proposeAgentRouteTool } from '../agent-runs/route-tools';
import { assignCodingRunTool } from '../agent-runs/assign-tool';
import { checkAgentRunsTool } from '../agent-runs/status-tool';
import { parseNangoIntegrationKeys } from './integrations';
import { listIntegrations, type NangoIntegration } from '../providers/nango';

// Enabled-integrations cache: the connections block wants the live Nango list every turn, but one
// HTTP round-trip per turn in the DO initializer is real latency. Cache per secret key for a few
// minutes; on fetch failure serve the last good list (stale beats blank).
const INTEGRATIONS_TTL_MS = 5 * 60_000;
const integrationsCache = new Map<string, { at: number; list: NangoIntegration[] }>();

async function enabledIntegrations(secretKey: string, fetchList: typeof listIntegrations): Promise<NangoIntegration[]> {
  const hit = integrationsCache.get(secretKey);
  if (hit && Date.now() - hit.at < INTEGRATIONS_TTL_MS) return hit.list;
  const list = await fetchList({ secretKey }).catch(() => hit?.list ?? []);
  integrationsCache.set(secretKey, { at: Date.now(), list });
  return list;
}

export interface ConnectionRuntime {
  tools: ToolDefinition[];
  connectionsBlock: string | null;
  state: ConnectionState[];
  canRequestConnections: boolean;
  providerCatalog: ProviderCatalogEntry[];
}

export interface ConnectionSnapshot {
  specs: ConnectionSpec[];
  enabledIntegrations: NangoIntegration[];
}

/** Load metadata at the gateway, before dispatch. Credentials and tool closures never cross
 *  this seam; the agent resolves them from its own isolate's bindings. */
export async function loadConnectionSnapshot(args: {
  db: D1Like | undefined;
  binding: Binding;
  env: Record<string, unknown>;
  listIntegrationsImpl?: typeof listIntegrations;
  strictDb?: boolean;
}): Promise<ConnectionSnapshot> {
  const { db, binding, env } = args;
  const specs = await loadConnectionSpecs(db, binding, { strictDb: args.strictDb }).catch(error => {
    if (args.strictDb) throw error;
    return binding.connections ?? [];
  });
  const secretKey = typeof env.NANGO_SECRET_KEY === 'string' ? env.NANGO_SECRET_KEY : '';
  const available = db && secretKey
    ? await enabledIntegrations(secretKey, args.listIntegrationsImpl ?? listIntegrations)
    : [];
  return { specs, enabledIntegrations: available };
}

/** Synchronous render-time assembly from metadata. Nango tokens remain lazy broker thunks. */
export function connectionRuntimeFromSnapshot(args: {
  db: D1Like | undefined;
  env: Record<string, unknown>;
  projectId: string;
  snapshot: ConnectionSnapshot;
  postConnectionLink?: (input: { conversationId: string; text: string }) => Promise<boolean>;
}): ConnectionRuntime {
  const { db, env, projectId } = args;
  const { specs, enabledIntegrations: available } = args.snapshot;
  const state = connectionState(specs, env);
  const secrets: Record<string, ResolvedConnection> = {};

  for (const s of state) {
    if (s.status !== 'connected') continue;
    const resolved = resolveConnection(specs, env, s.provider);
    if (resolved) secrets[s.provider] = resolved;
  }

  const nangoSecretKey = typeof env.NANGO_SECRET_KEY === 'string' ? env.NANGO_SECRET_KEY : '';
  const nangoIntegrationKeys = parseNangoIntegrationKeys(env.NANGO_INTEGRATION_KEYS);
  const canRequestConnect = !!db && !!nangoSecretKey;
  const nangoTools =
    canRequestConnect && db
      ? [
          requestConnectionTool(
            { nangoSecretKey, projectId, nangoIntegrationKeys, enabledIntegrationKeys: available.map((i) => i.uniqueKey) },
            { postConnectionLink: args.postConnectionLink },
          ),
          disconnectConnectionTool({ nangoSecretKey, projectId, db }),
        ]
      : [];
  const autoActivate = env.ROUTES_AUTO_ACTIVATE === 'true'; // dogfood flag: skip the admin counter-signature on routes
  const routeTools = db
    ? [proposeAgentRouteTool({ db, projectId, autoActivate }), assignCodingRunTool({ db, projectId }), checkAgentRunsTool({ db, projectId })]
    : [];

  // Audit recorder bound to this project: fire-and-forget, so a dead D1 never fails a turn.
  const audit = db ? toolCallRecorder(db, projectId) : undefined;

  return {
    tools: [...nangoTools, ...routeTools, ...connectionTools(state, secrets, nangoSecretKey || undefined, audit)],
    connectionsBlock:
      state.length || canRequestConnect ? renderConnectionsBlock(state, PROVIDER_CATALOG, canRequestConnect, available) : null,
    state,
    canRequestConnections: canRequestConnect,
    providerCatalog: PROVIDER_CATALOG,
  };
}

/** Async convenience for non-render callers and broker tests. */
export async function buildConnectionRuntime(args: {
  db: D1Like | undefined;
  binding: Binding;
  env: Record<string, unknown>;
  projectId: string;
  listIntegrationsImpl?: typeof listIntegrations;
  postConnectionLink?: (input: { conversationId: string; text: string }) => Promise<boolean>;
}): Promise<ConnectionRuntime> {
  return connectionRuntimeFromSnapshot({ ...args, snapshot: await loadConnectionSnapshot(args) });
}
