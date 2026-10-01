// Workbench M0 invariants — run: npx tsx src/workbench/workbench.test.ts
import assert from 'node:assert/strict';
import type { ToolDefinition } from '@flue/runtime';
import { createTestRunner, invokeTool } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';
import {
  claimWorkItem,
  createWorkItem,
  createWorkRun,
  getWorkItem,
  listWorkItems,
  registerArtifactRef,
  updateWorkItemStatus,
  updateWorkRun,
} from './repository';
import { workbenchTools } from './tools';
import { handleInternalWorkItemRequest } from './gateway';
import { agentInstanceId } from '../project/bindings';

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
                return {
                  results: db.workItems.filter((r) => r.project_id === projectId && r.dedupe_key === dedupeKey) as T[],
                };
              }
              if (query.includes('WHERE project_id=? AND id=?')) {
                const [projectId, id] = values;
                return { results: db.workItems.filter((r) => r.project_id === projectId && r.id === id) as T[] };
              }
              if (query.includes('WHERE id=?')) {
                const [id] = values;
                return { results: db.workItems.filter((r) => r.id === id) as T[] };
              }
              if (query.includes('WHERE project_id=? AND status=?')) {
                const [projectId, status, limit] = values;
                return {
                  results: db.workItems
                    .filter((r) => r.project_id === projectId && r.status === status)
                    .sort((a, b) => Number(b.updated_at) - Number(a.updated_at))
                    .slice(0, Number(limit)) as T[],
                };
              }
              if (query.includes('WHERE project_id=?')) {
                const [projectId, limit] = values;
                return {
                  results: db.workItems
                    .filter((r) => r.project_id === projectId)
                    .sort((a, b) => Number(b.updated_at) - Number(a.updated_at))
                    .slice(0, Number(limit)) as T[],
                };
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

            if (query.startsWith('UPDATE work_items') && query.includes("status='claimed'")) {
              const [claimedBy, sessionId, updatedByType, updatedById, updatedAt, projectId, id] = values;
              const row = db.workItems.find(
                (r) =>
                  r.project_id === projectId &&
                  r.id === id &&
                  (r.status === 'requested' || r.status === 'queued') &&
                  r.claimed_by == null,
              );
              if (!row) return { meta: { changes: 0 } };
              Object.assign(row, {
                status: 'claimed',
                claimed_by: claimedBy,
                session_id: sessionId,
                updated_by_type: updatedByType,
                updated_by_id: updatedById,
                updated_at: updatedAt,
              });
              return { meta: { changes: 1 } };
            }

            if (query.startsWith('UPDATE work_items')) {
              const [status, statusNote, updatedByType, updatedById, updatedAt, projectId, id] = values;
              const row = db.workItems.find((r) => r.project_id === projectId && r.id === id);
              if (!row) return { meta: { changes: 0 } };
              Object.assign(row, {
                status,
                status_note: statusNote,
                updated_by_type: updatedByType,
                updated_by_id: updatedById,
                updated_at: updatedAt,
              });
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
              const [
                status,
                dispatchStatus,
                externalRunId,
                summary,
                error,
                dispatchAttemptIncrement,
                dispatchedAt,
                lastDispatchError,
                updatedAt,
                id,
              ] = values;
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

test('createWorkItem: dedupes by project dedupe key and lists project items', async () => {
  const db = new FakeD1();
  const deps = seq();

  const first = await createWorkItem(db, { projectId: 'P', title: 'Fix bug', dedupeKey: ' issue-1 ' }, deps);
  const duplicate = await createWorkItem(db, { projectId: 'P', title: 'Different title', dedupeKey: 'issue-1' }, deps);
  const noDedupeA = await createWorkItem(db, { projectId: 'P', title: 'Manual' }, deps);
  const noDedupeB = await createWorkItem(db, { projectId: 'P', title: 'Manual' }, deps);
  await createWorkItem(db, { projectId: 'OTHER', title: 'Hidden', dedupeKey: 'issue-1' }, deps);

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.item.id, first.item.id);
  assert.notEqual(noDedupeA.item.id, noDedupeB.item.id);
  assert.deepEqual((await listWorkItems(db, 'P')).map((i) => i.id), [noDedupeB.item.id, noDedupeA.item.id, first.item.id]);
});

test('createWorkItem: parent ids must belong to the same project', async () => {
  const db = new FakeD1();
  const deps = seq();
  const parent = await createWorkItem(db, { projectId: 'P1', title: 'Parent' }, deps);

  await assert.rejects(() => createWorkItem(db, { projectId: 'P2', title: 'Bad child', parentId: parent.item.id }, deps), /parentId/);
  const child = await createWorkItem(db, { projectId: 'P1', title: 'Child', parentId: parent.item.id }, deps);
  assert.equal(child.item.parentId, parent.item.id);
});

test('claimWorkItem and updateWorkItemStatus enforce project and terminal guards', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createWorkItem(db, { projectId: 'P', title: 'Do work' }, deps);

  const claimed = await claimWorkItem(db, { projectId: 'P', id: created.item.id, claimedBy: 'agent', sessionId: 'work:P:1' }, deps);
  assert.equal(claimed?.status, 'claimed');
  assert.equal(await claimWorkItem(db, { projectId: 'P', id: created.item.id, claimedBy: 'agent2', sessionId: 'work:P:2' }, deps), null);

  assert.equal(await updateWorkItemStatus(db, { projectId: 'P', id: created.item.id, status: 'completed', updatedByType: 'system' }, deps).then((i) => i.status), 'completed');
  await assert.rejects(
    () => updateWorkItemStatus(db, { projectId: 'P', id: created.item.id, status: 'running', updatedByType: 'system' }, deps),
    /terminal/,
  );
  assert.equal(await claimWorkItem(db, { projectId: 'P', id: created.item.id, claimedBy: 'agent3', sessionId: 'work:P:3' }, deps), null);
  await assert.rejects(() => updateWorkItemStatus(db, { projectId: 'OTHER', id: created.item.id, status: 'failed', updatedByType: 'system' }, deps), /not found/);
});

test('work runs allocate attempts and track dispatch status', async () => {
  const db = new FakeD1();
  const deps = seq();
  const item = await createWorkItem(db, { projectId: 'P', title: 'Run me' }, deps);

  const run1 = await createWorkRun(db, { workItemId: item.item.id, runner: 'flue' }, deps);
  const updated = await updateWorkRun(
    db,
    { id: run1.id, status: 'pending', dispatchStatus: 'dispatched', externalRunId: 'flue-run', dispatchAttemptIncrement: 1 },
    deps,
  );
  const run2 = await createWorkRun(db, { workItemId: item.item.id, runner: 'e2b' }, deps);

  assert.equal(run1.attempt, 1);
  assert.equal(updated.dispatchStatus, 'dispatched');
  assert.equal(updated.dispatchAttempts, 1);
  assert.equal(run2.attempt, 2);
});

test('registerArtifactRef stores metadata only and rejects cross-project attachments', async () => {
  const db = new FakeD1();
  const deps = seq();
  const item = await createWorkItem(db, { projectId: 'P', title: 'Analyze file' }, deps);

  const ref = await registerArtifactRef(
    db,
    { projectId: 'P', workItemId: item.item.id, sourceProvider: 'manual', filename: 'data.csv', mimeType: 'text/csv', sizeBytes: 25 },
    deps,
  );

  assert.equal(ref.status, 'registered');
  assert.equal(ref.storageRef, null);
  await assert.rejects(
    () => registerArtifactRef(db, { projectId: 'OTHER', workItemId: item.item.id, sourceProvider: 'manual', filename: 'x.pdf' }, deps),
    /workItemId/,
  );
});

test('workbenchTools expose project-scoped model tools and restrict model status authority', async () => {
  const db = new FakeD1();
  const tools = workbenchTools(db, 'P', seq());

  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['create_work_item', 'get_work_item', 'list_work_items', 'update_work_item'],
  );

  const create = tool(tools, 'create_work_item');
  const list = tool(tools, 'list_work_items');
  const get = tool(tools, 'get_work_item');
  const update = tool(tools, 'update_work_item');

  const created = JSON.parse(await create({ title: 'Child task', body: 'Steps' }));
  assert.equal(created.title, 'Child task');
  assert.equal(JSON.parse(await list({ status: 'requested' })).length, 1);
  assert.equal(JSON.parse(await get({ id: created.id })).id, created.id);
  assert.equal(JSON.parse(await update({ id: created.id, status: 'running', statusNote: 'started' })).status, 'running');
  await assert.rejects(() => update({ id: created.id, status: 'queued' }), /not allowed/);
  await assert.rejects(() => update({ id: created.id, status: 'cancelled' }), /not allowed/);
});

test('handleInternalWorkItemRequest authenticates, dedupes, and records dispatch success/failure', async () => {
  const db = new FakeD1();
  const deps = seq();
  const bindingByProject = async (projectId: string) => (projectId === 'P' ? ({ projectId: 'P', status: 'active' } as const) : undefined);
  const dispatched: unknown[] = [];

  const unauthorized = await handleInternalWorkItemRequest(
    { db, expectedToken: 'secret', actualToken: 'wrong', body: { projectId: 'P', title: 'Nope' } },
    { bindingByProject, dispatch: async () => {}, ...deps },
  );
  assert.equal(unauthorized.status, 404);

  const inactive = await handleInternalWorkItemRequest(
    { db, expectedToken: 'secret', actualToken: 'secret', body: { projectId: 'NOPE', title: 'No binding' } },
    { bindingByProject, dispatch: async () => {}, ...deps },
  );
  assert.deepEqual(inactive.body, { skipped: 'no active binding' });

  const badSource = await handleInternalWorkItemRequest(
    { db, expectedToken: 'secret', actualToken: 'secret', body: { projectId: 'P', title: 'Bad source', sourceType: 'dropbox' } },
    { bindingByProject, dispatch: async () => {}, ...deps },
  );
  assert.equal(badSource.status, 400);
  assert.deepEqual(badSource.body, { error: 'unknown sourceType' });

  const manual = await handleInternalWorkItemRequest(
    { db, expectedToken: 'secret', actualToken: 'secret', body: { projectId: 'P', title: 'Manual', dispatch: false } },
    { bindingByProject, dispatch: async () => {}, ...deps },
  );
  assert.equal(manual.status, 200);
  assert.equal(manual.body?.dispatchStatus, 'not_requested');
  assert.equal(db.workRuns.length, 0);

  const first = await handleInternalWorkItemRequest(
    { db, expectedToken: 'secret', actualToken: 'secret', body: { projectId: 'P', title: 'From Linear', dedupeKey: 'linear:1' } },
    {
      bindingByProject,
      dispatch: async (input) => {
        dispatched.push(input);
      },
      ...deps,
    },
  );
  assert.equal(first.body?.duplicate, false);
  assert.equal(first.body?.dispatchStatus, 'dispatched');
  assert.equal(db.workRuns.length, 1);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0], {
    agent: 'project',
    id: agentInstanceId('P', `work:${first.body?.workItem.id}`),
    idempotencyKey: `work:${first.body?.run.id}`,
    input: { kind: 'work_item', workItemId: first.body?.workItem.id, title: 'From Linear' },
  });

  const duplicate = await handleInternalWorkItemRequest(
    { db, expectedToken: 'secret', actualToken: 'secret', body: { projectId: 'P', title: 'Again', dedupeKey: 'linear:1' } },
    { bindingByProject, dispatch: async () => dispatched.push('duplicate'), ...deps },
  );
  assert.equal(duplicate.body?.duplicate, true);
  assert.equal(duplicate.body?.dispatchStatus, 'deduped');
  assert.equal(db.workRuns.length, 1);
  assert.equal(dispatched.length, 1);

  const failed = await handleInternalWorkItemRequest(
    { db, expectedToken: 'secret', actualToken: 'secret', body: { projectId: 'P', title: 'Dispatch fails', dedupeKey: 'linear:2' } },
    {
      bindingByProject,
      dispatch: async () => {
        throw new Error('dispatch down');
      },
      ...deps,
    },
  );
  assert.equal(failed.body?.dispatchStatus, 'failed');
  assert.equal(failed.body?.workItem.status, 'blocked');
  assert.equal(db.workRuns.at(-1)?.dispatch_status, 'failed');
});

await run();
