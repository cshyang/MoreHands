// The assigner dispatch tool (the agent-as-main-task-assigner model). The channel agent hands work
// to the harness kit by EXPLICIT tool call — never by moving Linear state, which the bot-actor
// guard deliberately ignores (gateway automation must not self-trigger runs; intentional
// assignment goes through here instead).
//
// Authority chain: an admin-activated agent-run route is the standing grant (repo, base branch,
// kit). This tool only assigns within that grant — no active route, no assigning. The tool itself
// is DB-only: it writes a `queued` run row with the self-contained dispatch payload, and the
// reconcile cron (*/2) claims and dispatches it — no Trigger call inside the DO turn, so the
// ~12s fetch ceiling never applies here.

import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { D1Like } from '../skills/repository';
import { createAgentRunChannelNotifications, findActiveRouteForProject } from './events';
import { createAgentRun, getLatestAgentRunByLinearIssue } from './repository';

const ACTIVE_STATUSES = new Set(['queued', 'dispatching', 'running', 'waiting_human', 'waiting_approval']);

/** Issue key for ad-hoc assignments (no tracker identifier): short, branch-safe, title-derived.
 *  Keys the deterministic `harness/<id>` branch, so it must be stable enough to read in a PR list. */
export function adHocIdentifier(title: string, nowMs: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
  return `A-${slug || 'task'}-${nowMs.toString(36).slice(-4)}`;
}

export function assignCodingRunTool(args: { db: D1Like; projectId: string; now?: () => number }): ToolDefinition {
  const now = args.now ?? Date.now;
  return defineTool({
    name: 'assign_coding_run',
    description:
      'Assign a coding task to the autonomous coding harness: it plans, implements, verifies, and opens a DRAFT pull request ' +
      'against the repo this channel\'s active agent-run route grants. Use when work should end in a commit/PR — do small ' +
      'read-only jobs yourself instead. The description IS the contract the coding agent works from: state the goal in one ' +
      'sentence, list concrete acceptance criteria (one assertion per line), and name the verification command. A tightly ' +
      'specified small task takes the fast lane; anything ambiguous gets the full (slower) planning pipeline. ' +
      'Progress and the PR link come back to this channel as run notifications. To actively follow up (review the PR ' +
      'when it lands, chase a stuck run), set a one-shot reminder in the same turn whose prompt names this ' +
      'conversationId and the issueKey to check with check_agent_runs.',
    input: v.object({
      title: v.pipe(v.string(), v.description('One-line imperative goal, e.g. "Fix trailing hyphens in slugify".')),
      description: v.pipe(
        v.string(),
        v.description(
          'The work contract: context, concrete acceptance criteria (one per line), and the verification command. ' +
          'This is everything the coding agent gets — it has the repo but not this conversation.',
        ),
      ),
      identifier: v.optional(v.pipe(
        v.string(),
        v.description(
          'Issue key, e.g. a Linear identifier like FRD-12 when this tracks a real issue. Keys the work branch ' +
          '(harness/<identifier>) and dedupe. Omit for ad-hoc work — one is generated.',
        ),
      )),
      linearUrl: v.optional(v.pipe(v.string(), v.description('Linear issue URL when one exists, for receipts.'))),
    }),
    async run({ data: { title, description, identifier, linearUrl } }) {
      const route = await findActiveRouteForProject(args.db, args.projectId);
      if (!route) {
        return (
          'No active agent-run route for this project — there is no standing grant naming which repo coding runs may target. ' +
          'Propose one with propose_agent_route; an admin must activate it. Until then, assigning is not possible.'
        );
      }

      const t = now();
      const issueKey = (identifier ?? '').trim() || adHocIdentifier(String(title), t);

      // One live run per issue key: the harness branch is deterministic per issue, and a queued
      // duplicate would just serialize behind the first via the Trigger concurrency key. Refuse
      // loudly instead — re-assigning is legitimate only after the previous run reaches a terminal.
      const previous = await getLatestAgentRunByLinearIssue(args.db, args.projectId, issueKey);
      if (previous && ACTIVE_STATUSES.has(previous.status)) {
        return `"${issueKey}" already has a run in flight (run ${previous.id}, status ${previous.status}). Wait for it to finish or fail before re-assigning.`;
      }

      const { run, duplicate } = await createAgentRun(args.db, {
        projectId: args.projectId,
        routeId: route.id,
        sourceType: 'slack',
        sourceId: `assign:${issueKey}`,
        // Timestamped: idempotency here guards against accidental rapid double-writes only; the
        // real one-live-run rule is the pre-check above, and re-runs after a terminal are legal.
        idempotencyKey: `assign:${args.projectId}:${issueKey}:${t}`,
        linearIssueId: issueKey,
        linearIdentifier: issueKey,
        linearUrl: linearUrl ?? null,
        githubOwner: route.githubOwner,
        githubRepo: route.githubRepo,
        targetRepo: `${route.githubOwner}/${route.githubRepo}`,
        baseBranch: route.baseBranch,
        kit: route.kit,
        runtime: route.runtime,
        sandboxProvider: route.sandboxProvider,
        dispatchPayload: JSON.stringify({
          source: { type: 'slack', id: `assign:${issueKey}:${t}` },
          linearIssue: { id: issueKey, identifier: issueKey, url: linearUrl ?? '', title: String(title), description: String(description) },
          targetRepo: `${route.githubOwner}/${route.githubRepo}`,
          baseBranch: route.baseBranch,
          kit: route.kit,
          runtime: route.runtime,
          sandboxProvider: route.sandboxProvider,
        }),
      });

      await createAgentRunChannelNotifications(
        args.db,
        { projectId: args.projectId, runId: run.id, notificationType: 'run_started', linearTargetRef: issueKey },
        {},
      ).catch(() => null);

      return JSON.stringify({
        runId: run.id,
        issueKey,
        branch: `harness/${issueKey}`,
        repo: `${route.githubOwner}/${route.githubRepo}`,
        kit: route.kit,
        status: run.status,
        duplicate,
        note: 'Queued. The dispatcher picks it up within ~2 minutes; progress and the draft-PR link arrive in this channel.',
      });
    },
  });
}
