import type { D1Like } from '../skills/repository';
import type { Binding } from '../project/bindings';
import { agentInstanceId } from '../project/bindings';
import { hasMatchingSecretHeader } from '../gateway/auth';
import type { ProjectDispatchRequest } from '../gateway/dispatch';
import {
  WORK_ITEM_SOURCE_TYPES,
  createWorkItem,
  createWorkRun,
  updateWorkItemStatus,
  updateWorkRun,
  type ClockAndIds,
  type WorkItem,
} from './repository';

export type DispatchRequest = ProjectDispatchRequest;

export interface InternalWorkItemRouteResult {
  status: number;
  body?: any;
}

interface InternalWorkItemBody {
  projectId?: string;
  title?: string;
  body?: string;
  sourceType?: string;
  sourceId?: string;
  dedupeKey?: string;
  dispatch?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function workItemResponse(args: {
  workItem: WorkItem;
  run: unknown | null;
  duplicate: boolean;
  dispatchRequested: boolean;
  dispatchStatus: string;
  dispatchError?: string;
}) {
  return {
    workItem: args.workItem,
    run: args.run,
    duplicate: args.duplicate,
    dispatchRequested: args.dispatchRequested,
    dispatchStatus: args.dispatchStatus,
    ...(args.dispatchError ? { dispatchError: args.dispatchError } : {}),
  };
}

export async function handleInternalWorkItemRequest(
  req: {
    db: D1Like | undefined;
    expectedToken: string | undefined;
    actualToken: string | undefined;
    body: unknown;
  },
  deps: {
    bindingByProject(projectId: string, db?: D1Like): Promise<Pick<Binding, 'projectId' | 'status'> | undefined>;
    dispatch(input: DispatchRequest): Promise<unknown>;
  } & ClockAndIds,
): Promise<InternalWorkItemRouteResult> {
  if (!hasMatchingSecretHeader(req.expectedToken, req.actualToken)) return { status: 404 };
  if (!req.db) return { status: 500, body: { error: 'no DB binding' } };
  if (!isRecord(req.body)) return { status: 400, body: { error: 'bad request' } };

  const body = req.body as InternalWorkItemBody;
  if (!body.projectId || !body.title) return { status: 400, body: { error: 'projectId and title are required' } };
  if (body.sourceType && !WORK_ITEM_SOURCE_TYPES.includes(String(body.sourceType) as (typeof WORK_ITEM_SOURCE_TYPES)[number])) {
    return { status: 400, body: { error: 'unknown sourceType' } };
  }

  const binding = await deps.bindingByProject(String(body.projectId), req.db);
  if (!binding || binding.status !== 'active') return { status: 200, body: { skipped: 'no active binding' } };

  const created = await createWorkItem(
    req.db,
    {
      projectId: String(body.projectId),
      title: String(body.title),
      body: body.body == null ? null : String(body.body),
      sourceType: body.sourceType == null ? 'internal' : String(body.sourceType),
      sourceId: body.sourceId == null ? null : String(body.sourceId),
      dedupeKey: body.dedupeKey == null ? null : String(body.dedupeKey),
      updatedByType: 'gateway',
      updatedById: 'internal-route',
    },
    deps,
  );

  if (created.duplicate) {
    return {
      status: 200,
      body: workItemResponse({
        workItem: created.item,
        run: null,
        duplicate: true,
        dispatchRequested: false,
        dispatchStatus: 'deduped',
      }),
    };
  }

  if (body.dispatch === false) {
    return {
      status: 200,
      body: workItemResponse({
        workItem: created.item,
        run: null,
        duplicate: false,
        dispatchRequested: false,
        dispatchStatus: 'not_requested',
      }),
    };
  }

  const run = await createWorkRun(req.db, { workItemId: created.item.id, runner: 'flue', dispatchStatus: 'pending' }, deps);
  const dispatchInput: DispatchRequest = {
    agent: 'project',
    id: agentInstanceId(created.item.projectId, `work:${created.item.id}`),
    idempotencyKey: `work:${run.id}`,
    input: {
      kind: 'work_item',
      workItemId: created.item.id,
      title: created.item.title,
      ...(created.item.body ? { body: created.item.body } : {}),
    },
  };

  try {
    await deps.dispatch(dispatchInput);
    const updatedRun = await updateWorkRun(
      req.db,
      { id: run.id, status: 'pending', dispatchStatus: 'dispatched', dispatchAttemptIncrement: 1, dispatchedAt: deps.now?.() ?? Date.now() },
      deps,
    );
    const queued = await updateWorkItemStatus(
      req.db,
      { projectId: created.item.projectId, id: created.item.id, status: 'queued', updatedByType: 'gateway', updatedById: 'internal-route' },
      deps,
    );
    return {
      status: 200,
      body: workItemResponse({
        workItem: queued,
        run: updatedRun,
        duplicate: false,
        dispatchRequested: true,
        dispatchStatus: 'dispatched',
      }),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'dispatch failed';
    const failedRun = await updateWorkRun(
      req.db,
      { id: run.id, status: 'failed', dispatchStatus: 'failed', dispatchAttemptIncrement: 1, lastDispatchError: message, error: message },
      deps,
    );
    const blocked = await updateWorkItemStatus(
      req.db,
      {
        projectId: created.item.projectId,
        id: created.item.id,
        status: 'blocked',
        statusNote: `dispatch failed: ${message}`,
        updatedByType: 'gateway',
        updatedById: 'internal-route',
      },
      deps,
    );
    return {
      status: 200,
      body: workItemResponse({
        workItem: blocked,
        run: failedRun,
        duplicate: false,
        dispatchRequested: true,
        dispatchStatus: 'failed',
        dispatchError: message,
      }),
    };
  }
}
