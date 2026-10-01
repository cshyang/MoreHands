import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { Binding } from '../project/bindings';
import type { D1Like } from '../skills/repository';
import { connectionState, loadConnectionSpecs } from '../connections/repository';

const DEFAULT_RUNNER_RUNTIME = 'pi';
const DEFAULT_SANDBOX_PROVIDER = 'e2b';

export interface SetupConnectedProvider {
  provider: string;
  authMode?: string;
  repo?: string;
}

export interface SetupMissingItem {
  kind: 'provider' | 'route' | 'runner';
  provider?: string;
  authMode?: string;
  repo?: string;
  reason: string;
  nextAction: string;
}

export interface SetupRouteSummary {
  id: string;
  provider: string;
  externalKey: string;
  triggerType: string;
  triggerValue: string;
  status: string;
  targetRepo: string;
  baseBranch: string;
  kit: string;
  runtime: string;
  sandboxProvider: string;
}

export interface SetupRunnerSummary {
  configured: boolean;
  runtime: string;
  sandboxProvider: string;
}

export interface SetupNextAction {
  type: 'request_connection' | 'activate_route' | 'configure_runner' | 'none';
  provider?: string;
  authMode?: string;
  repo?: string;
  instruction: string;
}

export interface SetupStatus {
  ready: boolean;
  connected: SetupConnectedProvider[];
  missing: SetupMissingItem[];
  routes: SetupRouteSummary[];
  runner: SetupRunnerSummary;
  slack: { bound: boolean; teamId?: string; channelId?: string };
  githubRecommendation: { authMode: 'oauth' | 'pat'; repo?: string; reason: string };
  nextAction: SetupNextAction;
  /** Standing pointers worth relaying when someone asks about setup — not gaps, just affordances. */
  tips: string[];
  slackText: string;
  summary: string;
}

// Affordances that exist regardless of setup state; surfaced so the agent can mention them
// instead of users discovering them from the repo docs.
const SETUP_TIPS = [
  'Slash commands give instant read-only views without an agent turn: `/hands status | runs | reminders | skills | help`.',
  'Operators can verify the whole deployment leg by leg with `./scripts/setup.sh doctor`.',
];

interface AgentRunRouteRow {
  id: string;
  provider: string;
  external_key: string;
  trigger_type: string;
  trigger_value: string;
  github_owner: string;
  github_repo: string;
  base_branch: string;
  kit: string;
  runtime: string;
  sandbox_provider: string;
  status: string;
  priority?: number | null;
}

export async function buildSetupStatus(args: {
  db?: D1Like;
  binding: Binding;
  projectId: string;
  env?: Record<string, unknown>;
  targetRepo?: string | null;
  linearTeamKey?: string | null;
  intent?: string | null;
}): Promise<SetupStatus> {
  const env = args.env ?? {};
  const targetRepo = normalizeRepo(args.targetRepo);
  const linearTeamKey = normalizeText(args.linearTeamKey);
  const specs = await loadConnectionSpecs(args.db, args.binding).catch(() => args.binding.connections ?? []);
  const state = connectionState(specs, env);
  const connected = state.filter((s) => s.status === 'connected').map((s) => connectedProvider(s.provider, s.config));
  const hasGithub = connected.some((c) => c.provider === 'github');
  const hasLinear = connected.some((c) => c.provider === 'linear');

  const routes = args.db ? await loadRoutes(args.db, args.projectId).catch(() => []) : [];
  const activeRoute = routes.find((route) => routeMatches(route, { targetRepo, linearTeamKey, status: 'active' }));
  const runner = runnerSummary(env, hasGithub);
  const githubRecommendation = githubAuthRecommendation(targetRepo);

  const missing: SetupMissingItem[] = [];
  if (!hasGithub) {
    missing.push({
      kind: 'provider',
      provider: 'github',
      authMode: githubRecommendation.authMode,
      repo: githubRecommendation.repo,
      reason: targetRepo
        ? `GitHub is not connected for ${targetRepo}.`
        : 'GitHub is not connected.',
      nextAction:
        githubRecommendation.authMode === 'pat'
          ? `Call request_connection for github with authMode "pat" and repo "${targetRepo}".`
          : 'Call request_connection for github with authMode "oauth".',
    });
  }
  if (!hasLinear) {
    missing.push({
      kind: 'provider',
      provider: 'linear',
      authMode: 'oauth',
      reason: 'Linear is not connected.',
      nextAction: 'Call request_connection for linear.',
    });
  }
  if (!activeRoute) {
    missing.push({
      kind: 'route',
      provider: 'linear',
      reason: routeMissingReason({ targetRepo, linearTeamKey }),
      nextAction: 'Ask an admin to create or activate a Linear Run Agent route for this project.',
    });
  } else if (activeRoute.runtime !== DEFAULT_RUNNER_RUNTIME) {
    missing.push({
      kind: 'route',
      provider: 'linear',
      reason: `Active Linear Run Agent route uses legacy runtime "${activeRoute.runtime}".`,
      nextAction: 'Ask an admin to replace it with a Pi Agent Kits route before launching new runs.',
    });
  }
  if (!runner.configured) {
    missing.push({
      kind: 'runner',
      reason: 'Agent runner dispatch is not configured.',
      nextAction: 'Ask an operator to finish agent runner dispatch configuration (./scripts/setup.sh doctor shows exactly what is missing).',
    });
  }

  const nextAction = chooseNextAction(missing, githubRecommendation);
  const ready = missing.length === 0;
  const summary = ready ? 'Run Agent setup is ready for this project.' : setupSummary(missing);

  return {
    ready,
    connected,
    missing,
    routes,
    runner,
    slack: {
      bound: args.binding.status === 'active',
      teamId: args.binding.externalAccountId,
      channelId: args.binding.externalSpaceId,
    },
    githubRecommendation,
    nextAction,
    tips: SETUP_TIPS,
    slackText: renderSetupSlackText({ ready, connected, missing, routes, runner, nextAction, summary, tips: SETUP_TIPS }),
    summary,
  };
}

export function setupStatusTool(args: {
  db?: D1Like;
  binding: Binding;
  projectId: string;
  env?: Record<string, unknown>;
}): ToolDefinition {
  return defineTool({
    name: 'setup_status',
    description:
      'Return a secret-free setup checklist for this Slack project: connected providers, missing providers, route readiness, runner readiness, and the next action.',
    input: v.object({
      targetRepo: v.optional(v.pipe(v.string(), v.description('Optional GitHub owner/name repo the person wants to use.'))),
      linearTeamKey: v.optional(v.pipe(v.string(), v.description('Optional Linear team key/id, for example EDK.'))),
      intent: v.optional(v.pipe(v.string(), v.description('Optional setup intent, for example run_agent.'))),
    }),
    async run({ data: { targetRepo, linearTeamKey, intent } }) {
      const status = await buildSetupStatus({
        db: args.db,
        binding: args.binding,
        projectId: args.projectId,
        env: args.env ?? {},
        targetRepo: targetRepo == null ? null : String(targetRepo),
        linearTeamKey: linearTeamKey == null ? null : String(linearTeamKey),
        intent: intent == null ? null : String(intent),
      });
      return JSON.stringify(status, null, 2);
    },
  });
}

async function loadRoutes(db: D1Like, projectId: string): Promise<SetupRouteSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT id, provider, external_key, trigger_type, trigger_value, github_owner, github_repo,
              base_branch, kit, runtime, sandbox_provider, priority, status
         FROM agent_run_routes
        WHERE project_id=?
        ORDER BY priority DESC, created_at DESC`,
    )
    .bind(projectId)
    .all<AgentRunRouteRow>();
  return (results ?? []).map(routeSummary);
}

function routeSummary(row: AgentRunRouteRow): SetupRouteSummary {
  return {
    id: String(row.id),
    provider: String(row.provider),
    externalKey: String(row.external_key),
    triggerType: String(row.trigger_type),
    triggerValue: String(row.trigger_value),
    status: String(row.status),
    targetRepo: `${row.github_owner}/${row.github_repo}`,
    baseBranch: String(row.base_branch),
    kit: String(row.kit),
    runtime: String(row.runtime),
    sandboxProvider: String(row.sandbox_provider),
  };
}

function connectedProvider(provider: string, config: Record<string, unknown>): SetupConnectedProvider {
  const out: SetupConnectedProvider = { provider };
  const authMode = typeof config.authMode === 'string' ? config.authMode : undefined;
  const repo = typeof config.repo === 'string' ? config.repo : undefined;
  if (authMode) out.authMode = authMode;
  if (provider === 'github' && repo) out.repo = repo;
  return out;
}

function routeMatches(
  route: SetupRouteSummary,
  opts: { targetRepo: string | null; linearTeamKey: string | null; status: string },
): boolean {
  if (route.status !== opts.status) return false;
  if (route.provider !== 'linear') return false;
  if (route.triggerType !== 'state') return false;
  if (route.triggerValue !== 'Run Agent') return false;
  if (opts.linearTeamKey && route.externalKey !== opts.linearTeamKey) return false;
  if (opts.targetRepo && route.targetRepo.toLowerCase() !== opts.targetRepo.toLowerCase()) return false;
  return true;
}

function runnerSummary(env: Record<string, unknown>, githubConnected: boolean): SetupRunnerSummary {
  return {
    configured:
      hasEnvString(env, 'TRIGGER_SECRET_KEY') &&
      hasEnvString(env, 'AGENT_RUNNER_TOKEN') &&
      // Write credential, mirroring resolveDispatchGithubToken: the project's GitHub connection
      // (App installation token, preferred) or the RUNNER_GITHUB_PAT_TEMP fallback.
      (githubConnected || hasEnvString(env, 'RUNNER_GITHUB_PAT_TEMP')) &&
      hasEnvString(env, 'MOREHANDS_PUBLIC_URL'),
    runtime: DEFAULT_RUNNER_RUNTIME,
    sandboxProvider: DEFAULT_SANDBOX_PROVIDER,
  };
}

function githubAuthRecommendation(targetRepo: string | null): SetupStatus['githubRecommendation'] {
  if (targetRepo) {
    return {
      authMode: 'pat',
      repo: targetRepo,
      reason: 'Use GitHub PAT when the user wants access scoped to one repo.',
    };
  }
  return {
    authMode: 'oauth',
    reason: 'Use GitHub OAuth for normal workspace setup.',
  };
}

function chooseNextAction(missing: SetupMissingItem[], githubRecommendation: SetupStatus['githubRecommendation']): SetupNextAction {
  const provider = missing.find((m) => m.kind === 'provider');
  if (provider?.provider === 'github') {
    return {
      type: 'request_connection',
      provider: 'github',
      authMode: githubRecommendation.authMode,
      repo: githubRecommendation.repo,
      instruction:
        githubRecommendation.authMode === 'pat' && githubRecommendation.repo
          ? `Ask the person to connect GitHub PAT for ${githubRecommendation.repo}.`
          : 'Ask the person to connect GitHub OAuth.',
    };
  }
  if (provider?.provider === 'linear') {
    return {
      type: 'request_connection',
      provider: 'linear',
      authMode: 'oauth',
      instruction: 'Ask the person to connect Linear.',
    };
  }
  if (missing.some((m) => m.kind === 'route')) {
    return {
      type: 'activate_route',
      provider: 'linear',
      instruction: 'Ask an admin to create or activate the Linear Run Agent route.',
    };
  }
  if (missing.some((m) => m.kind === 'runner')) {
    return {
      type: 'configure_runner',
      instruction: 'Ask an operator to configure the agent runner.',
    };
  }
  return { type: 'none', instruction: 'Setup is ready.' };
}

function setupSummary(missing: SetupMissingItem[]): string {
  const labels = missing.map((m) => {
    if (m.kind === 'provider') return m.provider === 'github' ? 'GitHub connection' : 'Linear connection';
    if (m.kind === 'route') return 'Linear Run Agent route';
    return 'agent runner';
  });
  return `Run Agent setup is not ready. Missing: ${labels.join(', ')}.`;
}

function renderSetupSlackText(input: {
  ready: boolean;
  connected: SetupConnectedProvider[];
  missing: SetupMissingItem[];
  routes: SetupRouteSummary[];
  runner: SetupRunnerSummary;
  nextAction: SetupNextAction;
  summary: string;
  tips: string[];
}): string {
  const lines = [`*Run Agent setup*`, input.ready ? `✅ Ready — ${input.summary}` : `⚠️ ${input.summary}`];
  const connected = input.connected.length
    ? input.connected
        .map((c) => {
          const extra =
            c.provider === 'github' && c.repo
              ? ` (${c.authMode ?? 'connected'}: ${c.repo})`
              : c.authMode
                ? ` (${c.authMode})`
                : '';
          return `${c.provider}${extra}`;
        })
        .join(', ')
    : 'none';
  const activeRoutes = input.routes.filter((r) => r.status === 'active');
  lines.push(`Connected: ${connected}`);
  lines.push(`Runner: ${input.runner.configured ? 'ready' : 'missing'} (${input.runner.runtime}/${input.runner.sandboxProvider})`);
  lines.push(
    `Route: ${
      activeRoutes.length
        ? activeRoutes.map((r) => `${r.externalKey} ${r.triggerValue} -> ${r.targetRepo}`).join(', ')
        : 'missing active Linear Run Agent route'
    }`,
  );
  if (input.missing.length) {
    lines.push('', '*Missing*');
    for (const item of input.missing) lines.push(`• ${item.reason}`);
  }
  lines.push('', `Next: ${input.nextAction.instruction}`);
  if (input.tips.length) {
    lines.push('', '*Tips*');
    for (const tip of input.tips) lines.push(`• ${tip}`);
  }
  return lines.join('\n');
}

function routeMissingReason(opts: { targetRepo: string | null; linearTeamKey: string | null }): string {
  const pieces = ['No active Linear Run Agent route exists'];
  if (opts.linearTeamKey) pieces.push(`for Linear ${opts.linearTeamKey}`);
  if (opts.targetRepo) pieces.push(`to ${opts.targetRepo}`);
  return `${pieces.join(' ')}.`;
}

function hasEnvString(env: Record<string, unknown>, key: string): boolean {
  return typeof env[key] === 'string' && env[key] !== '';
}

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeRepo(value: string | null | undefined): string | null {
  const text = normalizeText(value);
  if (!text) return null;
  const match = text.match(/^([^/\s]+)\/([^/\s]+)$/);
  return match ? `${match[1]}/${match[2]}` : text;
}
