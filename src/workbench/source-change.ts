import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import { hasMatchingSecretHeader } from '../gateway/auth';
import { fetchWithTimeout, jsonMessageOrText } from '../providers/http';
import type { D1Like } from '../skills/repository';
import {
  createWorkItem,
  createWorkRun,
  getWorkItem,
  getWorkItemById,
  registerArtifactRef,
  updateWorkItemStatus,
  updateWorkRun,
  type ClockAndIds,
  type WorkItemStatus,
  type WorkRunStatus,
} from './repository';

const FETCH_TIMEOUT_MS = 10000;
const SOURCE_CHANGE_KIND = 'source_change';
const SOURCE_CHANGE_RUNNER = 'coding_webhook';
const ARTIFACT_FILENAME = 'source-change.json';

export type SourceChangeRisk = 'low' | 'medium' | 'high';
export type SourceChangeStatus = 'running' | 'pr_opened' | 'merged' | 'deployed' | 'failed';

export interface SourceChangeRequest {
  targetRepo: string;
  problem: string;
  evidence: string[];
  desiredBehavior: string;
  acceptanceTests: string[];
  risk: SourceChangeRisk;
  likelyFiles?: string[];
  baseBranch: string;
}

export interface SourceChangeArtifact {
  workItemId: string;
  runId?: string;
  status: SourceChangeStatus;
  branch?: string;
  commitSha?: string;
  prUrl?: string;
  ciUrl?: string;
  deployVersion?: string;
  summary?: string;
  error?: string;
}

export interface SourceChangeToolArgs {
  db: D1Like;
  projectId: string;
  runnerUrl?: string;
  runnerToken?: string;
  fetch?: typeof fetch;
  deps?: ClockAndIds;
}

export interface SourceChangeRouteResult {
  status: number;
  body?: any;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = 4096): string {
  const s = String(value ?? '').trim();
  if (!s) throw new Error(`${field} is required`);
  if (s.length > max) throw new Error(`${field} is too long`);
  return s;
}

function optionalText(value: unknown, field: string, max = 4096): string | undefined {
  if (value == null) return undefined;
  return text(value, field, max);
}

function textArray(value: unknown, field: string, required = true): string[] {
  if (value == null && !required) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const out = value.map((v) => String(v ?? '').trim()).filter(Boolean);
  if (required && !out.length) throw new Error(`${field} must include at least one item`);
  return out;
}

function normalizeRisk(value: unknown): SourceChangeRisk {
  const risk = String(value ?? '').trim();
  if (risk === 'low' || risk === 'medium' || risk === 'high') return risk;
  throw new Error('risk must be one of: low, medium, high');
}

function normalizeStatus(value: unknown): SourceChangeStatus {
  const status = String(value ?? '').trim();
  if (status === 'running' || status === 'pr_opened' || status === 'merged' || status === 'deployed' || status === 'failed') {
    return status;
  }
  throw new Error('status must be one of: running, pr_opened, merged, deployed, failed');
}

export function normalizeSourceChangeRequest(input: unknown): SourceChangeRequest {
  const v = record(input);
  const likelyFiles = textArray(v.likelyFiles, 'likelyFiles', false);
  return {
    targetRepo: text(v.targetRepo, 'targetRepo', 512),
    problem: text(v.problem, 'problem', 4096),
    evidence: textArray(v.evidence, 'evidence'),
    desiredBehavior: text(v.desiredBehavior, 'desiredBehavior', 4096),
    acceptanceTests: textArray(v.acceptanceTests, 'acceptanceTests'),
    risk: normalizeRisk(v.risk),
    ...(likelyFiles.length ? { likelyFiles } : {}),
    baseBranch: optionalText(v.baseBranch, 'baseBranch', 128) ?? 'main',
  };
}

function sourceChangeBody(request: SourceChangeRequest): string {
  return JSON.stringify({ kind: SOURCE_CHANGE_KIND, request }, null, 2);
}

function parseSourceChangeBody(body: string | null): SourceChangeRequest {
  const parsed = record(JSON.parse(body ?? '{}'));
  if (parsed.kind !== SOURCE_CHANGE_KIND) throw new Error('work item is not a source-change request');
  return normalizeSourceChangeRequest(parsed.request);
}

function sourceChangeTitle(request: SourceChangeRequest): string {
  const oneLine = request.problem.replace(/\s+/g, ' ').trim();
  return `Source change: ${oneLine.slice(0, 120)}`;
}

function runnerPayload(args: { projectId: string; workItemId: string; runId: string; request: SourceChangeRequest }) {
  return {
    projectId: args.projectId,
    workItemId: args.workItemId,
    runId: args.runId,
    request: args.request,
    callback: {
      path: '/__internal/source-change-runs',
      authHeader: 'x-morehands-runner-token',
    },
  };
}

async function dispatchToRunner(args: {
  runnerUrl: string;
  runnerToken: string;
  payload: unknown;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const res = await fetchWithTimeout(
    args.runnerUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-morehands-runner-token': args.runnerToken },
      body: JSON.stringify(args.payload),
    },
    {
      timeoutMs: FETCH_TIMEOUT_MS,
      timeoutMessage: `coding runner timed out after ${FETCH_TIMEOUT_MS}ms`,
      failurePrefix: 'coding runner dispatch failed',
      fetchImpl: args.fetchImpl,
    },
  );
  const textBody = await res.text();
  if (!res.ok) throw new Error(`coding runner ${res.status}: ${jsonMessageOrText(textBody, 160)}`);
  try {
    const data = JSON.parse(textBody) as { externalRunId?: unknown; id?: unknown };
    return typeof data.externalRunId === 'string' ? data.externalRunId : typeof data.id === 'string' ? data.id : null;
  } catch {
    return null;
  }
}

export async function proposeSourceChange(
  db: D1Like,
  projectId: string,
  input: unknown,
  deps: ClockAndIds = {},
) {
  const request = normalizeSourceChangeRequest(input);
  return createWorkItem(
    db,
    {
      projectId,
      title: sourceChangeTitle(request),
      body: sourceChangeBody(request),
      sourceType: 'internal',
      updatedByType: 'model',
      updatedById: 'agent',
    },
    deps,
  );
}

export async function dispatchSourceChangeRun(
  db: D1Like,
  projectId: string,
  workItemId: string,
  args: { runnerUrl: string; runnerToken: string; fetch?: typeof fetch; deps?: ClockAndIds },
) {
  const item = await getWorkItem(db, projectId, workItemId);
  if (!item) throw new Error('work item not found');
  const request = parseSourceChangeBody(item.body);
  const deps = args.deps ?? {};
  const run = await createWorkRun(db, { workItemId: item.id, runner: SOURCE_CHANGE_RUNNER, dispatchStatus: 'pending' }, deps);
  const payload = runnerPayload({ projectId, workItemId: item.id, runId: run.id, request });
  try {
    const externalRunId = await dispatchToRunner({ runnerUrl: args.runnerUrl, runnerToken: args.runnerToken, payload, fetchImpl: args.fetch });
    const updatedRun = await updateWorkRun(
      db,
      { id: run.id, status: 'running', dispatchStatus: 'dispatched', externalRunId, dispatchAttemptIncrement: 1, dispatchedAt: deps.now?.() ?? Date.now() },
      deps,
    );
    const updatedItem = await updateWorkItemStatus(
      db,
      { projectId, id: item.id, status: 'running', statusNote: 'coding runner dispatched', updatedByType: 'model', updatedById: 'agent' },
      deps,
    );
    return { workItem: updatedItem, run: updatedRun, dispatchStatus: 'dispatched' };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'coding runner dispatch failed';
    const failedRun = await updateWorkRun(
      db,
      { id: run.id, status: 'failed', dispatchStatus: 'failed', error: message, lastDispatchError: message, dispatchAttemptIncrement: 1 },
      deps,
    );
    const blocked = await updateWorkItemStatus(
      db,
      { projectId, id: item.id, status: 'blocked', statusNote: `coding runner dispatch failed: ${message}`, updatedByType: 'model', updatedById: 'agent' },
      deps,
    );
    return { workItem: blocked, run: failedRun, dispatchStatus: 'failed', dispatchError: message };
  }
}

export function sourceChangeTools(args: SourceChangeToolArgs): ToolDefinition[] {
  const propose = defineTool({
    name: 'propose_self_change',
    description:
      'Create a structured MoreHands workbench item for a proposed source-code change to MoreHands itself. ' +
      'Use this when the agent notices a code-level improvement, bug, missing tool, or runtime limitation. ' +
      'This does NOT edit code, create a GitHub issue, merge, or deploy.',
    input: v.object({
      targetRepo: v.pipe(v.string(), v.description('Repository to change, e.g. github.com/org/repo. Required; do not guess.')),
      problem: v.pipe(v.string(), v.description('The problem or limitation observed.')),
      evidence: v.array(v.pipe(v.string(), v.description('Concrete observations or user requests supporting the change.'))),
      desiredBehavior: v.pipe(v.string(), v.description('What should work after the change.')),
      acceptanceTests: v.array(v.pipe(v.string(), v.description('Tests or checks that prove the change worked.'))),
      risk: v.pipe(v.string(), v.description('Risk level: low, medium, or high.')),
      likelyFiles: v.optional(v.array(v.pipe(v.string(), v.description('Likely repo files to inspect or change.')))),
      baseBranch: v.optional(v.pipe(v.string(), v.description('Base branch for the runner; defaults to main.'))),
    }),
    async run({ data: input }) {
      const created = await proposeSourceChange(args.db, args.projectId, input, args.deps);
      return JSON.stringify(created.item, null, 2);
    },
  });

  const tools = [propose];
  if (!args.runnerUrl || !args.runnerToken) return tools;

  const dispatch = defineTool({
    name: 'dispatch_coding_run',
    description:
      'Dispatch a source-change work item to the configured generic coding runner. The runner owns clone/edit/test/commit/PR. ' +
      'This tool only records the run and sends the structured request; it cannot merge or deploy.',
    input: v.object({
      workItemId: v.pipe(v.string(), v.description('The source-change work item id returned by propose_self_change.')),
    }),
    async run({ data: { workItemId } }) {
      const result = await dispatchSourceChangeRun(args.db, args.projectId, String(workItemId), {
        runnerUrl: args.runnerUrl as string,
        runnerToken: args.runnerToken as string,
        fetch: args.fetch,
        deps: args.deps,
      });
      return JSON.stringify(result, null, 2);
    },
  });
  return [...tools, dispatch];
}

function callbackArtifact(input: unknown): SourceChangeArtifact {
  const body = record(input);
  const artifact: SourceChangeArtifact = {
    workItemId: text(body.workItemId, 'workItemId', 256),
    status: normalizeStatus(body.status),
  };
  const runId = optionalText(body.runId, 'runId', 256);
  const branch = optionalText(body.branch, 'branch', 512);
  const commitSha = optionalText(body.commitSha, 'commitSha', 128);
  const prUrl = optionalText(body.prUrl, 'prUrl', 2048);
  const ciUrl = optionalText(body.ciUrl, 'ciUrl', 2048);
  const deployVersion = optionalText(body.deployVersion, 'deployVersion', 256);
  const summary = optionalText(body.summary, 'summary', 4096);
  const error = optionalText(body.error, 'error', 4096);
  return {
    ...artifact,
    ...(runId ? { runId } : {}),
    ...(branch ? { branch } : {}),
    ...(commitSha ? { commitSha } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(ciUrl ? { ciUrl } : {}),
    ...(deployVersion ? { deployVersion } : {}),
    ...(summary ? { summary } : {}),
    ...(error ? { error } : {}),
  };
}

function mappedWorkItemStatus(status: SourceChangeStatus): WorkItemStatus {
  if (status === 'running') return 'running';
  if (status === 'pr_opened') return 'waiting_approval';
  if (status === 'merged' || status === 'deployed') return 'completed';
  return 'failed';
}

function mappedRunStatus(status: SourceChangeStatus): WorkRunStatus {
  if (status === 'merged' || status === 'deployed') return 'completed';
  if (status === 'running' || status === 'pr_opened') return 'running';
  return 'failed';
}

function shouldRegisterArtifact(status: SourceChangeStatus): boolean {
  return status === 'pr_opened' || status === 'merged' || status === 'deployed' || status === 'failed';
}

export async function handleSourceChangeRunCallback(
  req: {
    db: D1Like | undefined;
    expectedToken: string | undefined;
    actualToken: string | undefined;
    body: unknown;
  },
  deps: ClockAndIds = {},
): Promise<SourceChangeRouteResult> {
  if (!hasMatchingSecretHeader(req.expectedToken, req.actualToken)) return { status: 404 };
  if (!req.db) return { status: 500, body: { error: 'no DB binding' } };
  try {
    const artifact = callbackArtifact(req.body);
    const item = await getWorkItemById(req.db, artifact.workItemId);
    if (!item) return { status: 400, body: { error: 'work item not found' } };
    const workStatus = mappedWorkItemStatus(artifact.status);
    const statusNote = artifact.error ?? artifact.summary ?? `source change ${artifact.status}`;
    const updatedItem = await updateWorkItemStatus(
      req.db,
      { projectId: item.projectId, id: item.id, status: workStatus, statusNote, updatedByType: 'system', updatedById: 'coding-runner' },
      deps,
    );
    const updatedRun = artifact.runId
      ? await updateWorkRun(
          req.db,
          { id: artifact.runId, status: mappedRunStatus(artifact.status), error: artifact.error, summary: artifact.summary },
          deps,
        )
      : null;
    const ref = shouldRegisterArtifact(artifact.status)
      ? await registerArtifactRef(
          req.db,
          {
            projectId: item.projectId,
            workItemId: item.id,
            sourceProvider: 'source_change',
            sourceId: artifact.prUrl ?? artifact.commitSha ?? artifact.runId ?? artifact.status,
            filename: ARTIFACT_FILENAME,
            mimeType: 'application/json',
            status: artifact.status === 'failed' ? 'failed' : 'registered',
            summary: JSON.stringify(artifact),
          },
          deps,
        )
      : null;
    return { status: 200, body: { workItem: updatedItem, run: updatedRun, artifact: ref } };
  } catch (e) {
    return { status: 400, body: { error: e instanceof Error ? e.message : 'bad request' } };
  }
}
