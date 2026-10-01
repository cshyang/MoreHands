// Run-status visibility for the channel agent. The runner reports milestones (running, PR opened,
// completed/failed) into the agent_runs rows; this tool reads those rows so the agent can answer
// "how's the run going?" instead of being blind between channel notifications. Read-only: the
// reconciler already posts milestone notifications to the channel, so this is for answering
// questions and reminder-driven follow-ups, not for re-announcing.

import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { D1Like } from '../skills/repository';
import { getLatestAgentRunByIssueKey, listRecentAgentRuns, type AgentRun } from './repository';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const TEXT_CAP = 400;

function clip(text: string | null): string | null {
  if (!text) return null;
  return text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}…` : text;
}

/** The model-safe projection of a run row: status and receipts only — never the dispatch
 *  payload, idempotency key, or sandbox internals. */
function runView(run: AgentRun, nowMs: number) {
  return {
    runId: run.id,
    issueKey: run.linearIdentifier,
    repo: run.targetRepo,
    kit: run.kit,
    status: run.status,
    branch: run.branch,
    prUrl: run.prUrl,
    summary: clip(run.summary),
    error: clip(run.error),
    statusNote: clip(run.statusNote),
    createdAt: new Date(run.createdAt).toISOString(),
    updatedAt: new Date(run.updatedAt).toISOString(),
    minutesSinceHeartbeat: run.lastHeartbeatAt ? Math.max(0, Math.round((nowMs - run.lastHeartbeatAt) / 60_000)) : null,
  };
}

export function checkAgentRunsTool(args: { db: D1Like; projectId: string; now?: () => number }): ToolDefinition {
  const now = args.now ?? Date.now;
  return defineTool({
    name: 'check_agent_runs',
    description:
      'Check the coding runs of this channel (newest first): status (queued → dispatching → running → completed/failed), ' +
      'branch, draft-PR link, summary or error, and minutes since the runner last reported (runs silent past ~3h are presumed ' +
      'dead). The runner only reports at milestones, so a healthy run can look quiet for a while — a PR link appearing means ' +
      'the work is up for review. Use this when someone asks how a run is going, or after a one-shot set_reminder fires to ' +
      'follow up on a run you assigned. Milestone notifications already post to this channel automatically; do not re-announce ' +
      'what the channel has already seen. Pass issueKey to get the latest run for one issue.',
    input: v.object({
      issueKey: v.optional(v.pipe(v.string(), v.description('Issue key (e.g. "WID-71") — returns that issue\'s latest run only.'))),
      limit: v.optional(v.pipe(v.number(), v.description(`How many recent runs to list (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`))),
    }),
    async run({ data: { issueKey, limit } }) {
      const t = now();
      const key = typeof issueKey === 'string' ? issueKey.trim() : '';
      if (key) {
        const run = await getLatestAgentRunByIssueKey(args.db, args.projectId, key);
        if (!run) return `No runs for "${key}" in this project.`;
        return JSON.stringify(runView(run, t));
      }
      const n = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
      const runs = await listRecentAgentRuns(args.db, args.projectId, n);
      if (runs.length === 0) return 'No agent runs for this project yet.';
      return JSON.stringify(runs.map((run) => runView(run, t)));
    },
  });
}
