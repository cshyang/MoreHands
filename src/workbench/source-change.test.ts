// Source-change workbench invariants — run: npx tsx src/workbench/source-change.test.ts
import assert from 'node:assert/strict';
import type { ToolDefinition } from '@flue/runtime';
import { createTestRunner, invokeTool } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';
import { createWorkItem, createWorkRun, getWorkItem } from './repository';
import { handleSourceChangeRunCallback, sourceChangeTools } from './source-change';

const { test, run } = createTestRunner();

type Row = Record<string, unknown>;

class FakeD1 implements D1Like {
  workItems: Row[] = [];
  workRuns: Row[] = [];
  artifactRefs: Row[] = [];

  prepare(query: string) {
    const db = this;
    return {
      bind(...values: unknown[]) {
        return {
          async first<T = Record<string, unknown>>(): Promise<T | null> {
            const { results } = await this.all<T>();
            return results[0] ?? null;
          },
          async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
            if (query.startsWith('SELECT') && query.includes('FROM work_items')) {
              if (query.includes('WHERE project_id=? AND dedupe_key=?')) {
                const [projectId, dedupeKey] = values;
                return { results: db.workItems.filter((r) => r.project_id === projectId && r.dedupe_key === dedupeKey) as T[] };
              }
              if (query.includes('WHERE project_id=? AND id=?')) {
                const [projectId, id] = values;
                return { results: db.workItems.filter((r) => r.project_id === projectId && r.id === id) as T[] };
              }
              if (query.includes('WHERE id=?')) {
                const [id] = values;
                return { results: db.workItems.filter((r) => r.id === id) as T[] };
              }
            }
            if (query.startsWith('SELECT') && query.includes('FROM work_runs')) {
              if (query.includes('COALESCE(MAX(attempt)')) {
                const [workItemId] = values;
                const max = db.workRuns
                  .filter((r) => r.work_item_id === workItemId)
                  .reduce((m, r) => Math.max(m, Number(r.attempt)), 0);
                return { results: [{ max_attempt: max }] as T[] };
              }
              if (query.includes('WHERE id=?')) {
                const [id] = values;
                return { results: db.workRuns.filter((r) => r.id === id) as T[] };
              }
            }
            return { results: [] as T[] };
          },
          async run(): Promise<{ meta: { changes: number } }> {
            if (query.startsWith('INSERT INTO work_items')) {
              const [
                id,
                projectId,
                parentId,
                sourceType,
                sourceId,
                dedupeKey,
                title,
                body,
                status,
                priority,
                claimedBy,
                sessionId,
                statusNote,
                updatedByType,
                updatedById,
                createdAt,
                updatedAt,
              ] = values;
              db.workItems.push({
                id,
                project_id: projectId,
                parent_id: parentId,
                source_type: sourceType,
                source_id: sourceId,
                dedupe_key: dedupeKey,
                title,
                body,
                status,
                priority,
                claimed_by: claimedBy,
                session_id: sessionId,
                status_note: statusNote,
                updated_by_type: updatedByType,
                updated_by_id: updatedById,
                created_at: createdAt,
                updated_at: updatedAt,
              });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('UPDATE work_items')) {
              const [status, statusNote, updatedByType, updatedById, updatedAt, projectId, id] = values;
              const row = db.workItems.find((r) => r.project_id === projectId && r.id === id);
              if (!row) return { meta: { changes: 0 } };
              Object.assign(row, { status, status_note: statusNote, updated_by_type: updatedByType, updated_by_id: updatedById, updated_at: updatedAt });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('INSERT INTO work_runs')) {
              const [
                id,
                workItemId,
                runner,
                attempt,
                status,
                dispatchStatus,
                externalRunId,
                summary,
                error,
                dispatchAttempts,
                dispatchedAt,
                lastDispatchError,
                createdAt,
                updatedAt,
              ] = values;
              db.workRuns.push({
                id,
                work_item_id: workItemId,
                runner,
                attempt,
                status,
                dispatch_status: dispatchStatus,
                external_run_id: externalRunId,
                summary,
                error,
                dispatch_attempts: dispatchAttempts,
                dispatched_at: dispatchedAt,
                last_dispatch_error: lastDispatchError,
                created_at: createdAt,
                updated_at: updatedAt,
              });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('UPDATE work_runs')) {
              const [status, dispatchStatus, externalRunId, summary, error, dispatchAttemptIncrement, dispatchedAt, lastDispatchError, updatedAt, id] = values;
              const row = db.workRuns.find((r) => r.id === id);
              if (!row) return { meta: { changes: 0 } };
              Object.assign(row, {
                status,
                dispatch_status: dispatchStatus,
                external_run_id: externalRunId,
                summary,
                error,
                dispatch_attempts: Number(row.dispatch_attempts ?? 0) + Number(dispatchAttemptIncrement),
                dispatched_at: dispatchedAt,
                last_dispatch_error: lastDispatchError,
                updated_at: updatedAt,
              });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('INSERT INTO artifact_refs')) {
              const [id, projectId, workItemId, sourceProvider, sourceId, filename, mimeType, sizeBytes, storageRef, sha256, status, summary, createdAt, updatedAt] =
                values;
              db.artifactRefs.push({
                id,
                project_id: projectId,
                work_item_id: workItemId,
                source_provider: sourceProvider,
                source_id: sourceId,
                filename,
                mime_type: mimeType,
                size_bytes: sizeBytes,
                storage_ref: storageRef,
                sha256,
                status,
                summary,
                created_at: createdAt,
                updated_at: updatedAt,
              });
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
        };
      },
    };
  }
}

function seq() {
  let n = 0;
  return {
    id: () => `id-${++n}`,
    now: () => 1000 + n,
  };
}

function tool(tools: ToolDefinition[], name: string) {
  const found = tools.find((t) => t.name === name);
  assert.ok(found, `missing tool ${name}`);
  return (args: Record<string, unknown>) => invokeTool(found, args);
}

const request = {
  targetRepo: 'github.com/acme/hatchery',
  problem: 'self_status cannot report source evolution',
  evidence: ['User asked whether MoreHands can evolve its own code'],
  desiredBehavior: 'The agent proposes source changes and tracks the PR result',
  acceptanceTests: ['source change proposal creates a work item', 'runner callback records a PR artifact'],
  risk: 'medium',
  likelyFiles: ['src/agent/self.ts', 'src/workbench/source-change.ts'],
};

test('propose_self_change creates a project-scoped structured source-change work item', async () => {
  const db = new FakeD1();
  const propose = tool(sourceChangeTools({ db, projectId: 'P', deps: seq() }), 'propose_self_change');

  const item = JSON.parse(await propose(request));
  const body = JSON.parse(item.body);

  assert.equal(item.projectId, 'P');
  assert.equal(item.sourceType, 'internal');
  assert.match(item.title, /Source change/);
  assert.equal(body.kind, 'source_change');
  assert.equal(body.request.targetRepo, request.targetRepo);
  assert.equal(body.request.baseBranch, 'main');
  assert.deepEqual(body.request.acceptanceTests, request.acceptanceTests);
});

test('dispatch_coding_run creates a coding_webhook run and posts the generic runner payload', async () => {
  const db = new FakeD1();
  const deps = seq();
  const captured: { current?: { url: string; init: RequestInit; body: any } } = {};
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    captured.current = { url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')) };
    return new Response(JSON.stringify({ externalRunId: 'runner-42' }), { status: 202 });
  };
  const tools = sourceChangeTools({
    db,
    projectId: 'P',
    runnerUrl: 'https://runner.example/run',
    runnerToken: 'runner-secret',
    fetch: fetcher,
    deps,
  });
  const item = JSON.parse(await tool(tools, 'propose_self_change')(request));
  const result = JSON.parse(await tool(tools, 'dispatch_coding_run')({ workItemId: item.id }));

  assert.equal(result.dispatchStatus, 'dispatched');
  assert.equal(db.workRuns[0].runner, 'coding_webhook');
  assert.equal(db.workRuns[0].dispatch_status, 'dispatched');
  assert.equal(db.workRuns[0].external_run_id, 'runner-42');
  assert.equal(db.workItems[0].status, 'running');
  const sent = captured.current;
  assert.ok(sent);
  assert.equal(sent.url, 'https://runner.example/run');
  assert.equal((sent.init.headers as Record<string, string>)['x-morehands-runner-token'], 'runner-secret');
  assert.equal(JSON.stringify(sent.body).includes('runner-secret'), false);
  assert.equal(sent.body.workItemId, item.id);
  assert.equal(sent.body.runId, db.workRuns[0].id);
  assert.equal(sent.body.request.targetRepo, request.targetRepo);
});

test('dispatch_coding_run records failed runner dispatch without losing the work item', async () => {
  const db = new FakeD1();
  const deps = seq();
  const tools = sourceChangeTools({
    db,
    projectId: 'P',
    runnerUrl: 'https://runner.example/run',
    runnerToken: 'runner-secret',
    fetch: async () => new Response('down', { status: 500 }),
    deps,
  });
  const item = JSON.parse(await tool(tools, 'propose_self_change')(request));
  const result = JSON.parse(await tool(tools, 'dispatch_coding_run')({ workItemId: item.id }));

  assert.equal(result.dispatchStatus, 'failed');
  assert.equal(db.workRuns[0].status, 'failed');
  assert.equal(db.workRuns[0].dispatch_status, 'failed');
  assert.equal(db.workItems[0].status, 'blocked');
  assert.match(String(db.workItems[0].status_note), /coding runner dispatch failed/);
});

test('source-change runner callback rejects missing or wrong runner token', async () => {
  const db = new FakeD1();
  const wrong = await handleSourceChangeRunCallback(
    { db, expectedToken: 'runner-secret', actualToken: 'wrong', body: { workItemId: 'id-1', status: 'pr_opened' } },
    seq(),
  );
  const missing = await handleSourceChangeRunCallback(
    { db, expectedToken: undefined, actualToken: undefined, body: { workItemId: 'id-1', status: 'pr_opened' } },
    seq(),
  );

  assert.equal(wrong.status, 404);
  assert.equal(missing.status, 404);
});

test('source-change runner callback maps PR, deploy, and failure statuses to workbench state', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createWorkItem(db, { projectId: 'P', title: 'Source change', body: JSON.stringify({ kind: 'source_change', request }) }, deps);
  const run = await createWorkRun(db, { workItemId: created.item.id, runner: 'coding_webhook', status: 'running', dispatchStatus: 'dispatched' }, deps);

  const pr = await handleSourceChangeRunCallback(
    {
      db,
      expectedToken: 'runner-secret',
      actualToken: 'runner-secret',
      body: { workItemId: created.item.id, runId: run.id, status: 'pr_opened', branch: 'agent/self-change', prUrl: 'https://github.com/acme/hatchery/pull/1', ciUrl: 'https://ci/1' },
    },
    deps,
  );
  assert.equal(pr.status, 200);
  assert.equal((await getWorkItem(db, 'P', created.item.id))?.status, 'waiting_approval');
  assert.equal(db.workRuns[0].status, 'running');
  assert.equal(db.artifactRefs[0].source_provider, 'source_change');
  assert.equal(JSON.parse(String(db.artifactRefs[0].summary)).prUrl, 'https://github.com/acme/hatchery/pull/1');

  const deployed = await handleSourceChangeRunCallback(
    {
      db,
      expectedToken: 'runner-secret',
      actualToken: 'runner-secret',
      body: { workItemId: created.item.id, runId: run.id, status: 'deployed', deployVersion: 'v123', summary: 'deployed' },
    },
    deps,
  );
  assert.equal(deployed.status, 200);
  assert.equal((await getWorkItem(db, 'P', created.item.id))?.status, 'completed');
  assert.equal(db.workRuns[0].status, 'completed');

  const failedItem = await createWorkItem(db, { projectId: 'P', title: 'Failed source change', body: JSON.stringify({ kind: 'source_change', request }) }, deps);
  const failedRun = await createWorkRun(db, { workItemId: failedItem.item.id, runner: 'coding_webhook', status: 'running', dispatchStatus: 'dispatched' }, deps);
  const failed = await handleSourceChangeRunCallback(
    {
      db,
      expectedToken: 'runner-secret',
      actualToken: 'runner-secret',
      body: { workItemId: failedItem.item.id, runId: failedRun.id, status: 'failed', error: 'tests failed' },
    },
    deps,
  );
  assert.equal(failed.status, 200);
  assert.equal((await getWorkItem(db, 'P', failedItem.item.id))?.status, 'failed');
  assert.equal(db.workRuns[1].status, 'failed');
  assert.equal(db.artifactRefs.at(-1)?.status, 'failed');
});

await run();
