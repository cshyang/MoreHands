import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { D1Like } from '../skills/repository';
import {
  MODEL_WORK_ITEM_STATUSES,
  createWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItemStatus,
  type ClockAndIds,
} from './repository';

export function workbenchTools(db: D1Like, projectId: string, deps: ClockAndIds = {}): ToolDefinition[] {
  const create = defineTool({
    name: 'create_work_item',
    description:
      'Record a durable project work item or child task in the MoreHands workbench. Use this for todo items, decomposition, and task tracking.',
    input: v.object({
      title: v.pipe(v.string(), v.description('Short task title.')),
      body: v.optional(v.pipe(v.string(), v.description('Optional task detail, acceptance notes, or current context.'))),
      parentId: v.optional(v.pipe(v.string(), v.description('Optional parent work item id in this same project.'))),
      priority: v.optional(v.pipe(v.number(), v.description('Optional priority; higher numbers sort earlier in future UI.'))),
    }),
    async run({ data: { title, body, parentId, priority } }) {
      const { item } = await createWorkItem(
        db,
        {
          projectId,
          title: String(title),
          body: body == null ? null : String(body),
          parentId: parentId == null ? null : String(parentId),
          priority: priority == null ? 0 : Number(priority),
          sourceType: 'manual',
          updatedByType: 'model',
          updatedById: 'agent',
        },
        deps,
      );
      return JSON.stringify(item, null, 2);
    },
  });

  const list = defineTool({
    name: 'list_work_items',
    description: 'List durable project work items from the MoreHands workbench, optionally filtered by status.',
    input: v.object({
      status: v.optional(v.pipe(v.string(), v.description('Optional status filter, e.g. requested, running, blocked, completed.'))),
      limit: v.optional(v.pipe(v.number(), v.description('Maximum rows to return; defaults to 25.'))),
    }),
    async run({ data: { status, limit } }) {
      const items = await listWorkItems(db, projectId, {
        status: status == null ? null : String(status),
        limit: limit == null ? null : Number(limit),
      });
      return JSON.stringify(items, null, 2);
    },
  });

  const get = defineTool({
    name: 'get_work_item',
    description: 'Read one durable project work item by id before acting on it or updating its progress.',
    input: v.object({ id: v.pipe(v.string(), v.description('Work item id.')) }),
    async run({ data: { id } }) {
      const item = await getWorkItem(db, projectId, String(id));
      if (!item) throw new Error('work item not found');
      return JSON.stringify(item, null, 2);
    },
  });

  const update = defineTool({
    name: 'update_work_item',
    description:
      'Update progress on one of this project\'s work items. Allowed status values: running, waiting_approval, blocked, completed, failed.',
    input: v.object({
      id: v.pipe(v.string(), v.description('Work item id.')),
      status: v.optional(v.pipe(v.string(), v.description('Allowed: running, waiting_approval, blocked, completed, failed.'))),
      statusNote: v.optional(v.pipe(v.string(), v.description('Short note explaining the current progress or blocker.'))),
    }),
    async run({ data: { id, status, statusNote } }) {
      if (!status && statusNote == null) throw new Error('status or statusNote is required');
      const item = await getWorkItem(db, projectId, String(id));
      if (!item) throw new Error('work item not found');
      const nextStatus = status == null ? item.status : String(status);
      if (!MODEL_WORK_ITEM_STATUSES.includes(nextStatus as (typeof MODEL_WORK_ITEM_STATUSES)[number])) {
        throw new Error(`status "${nextStatus}" is not allowed for the model`);
      }
      const updated = await updateWorkItemStatus(
        db,
        {
          projectId,
          id: String(id),
          status: nextStatus,
          statusNote: statusNote == null ? item.statusNote : String(statusNote),
          updatedByType: 'model',
          updatedById: 'agent',
        },
        deps,
      );
      return JSON.stringify(updated, null, 2);
    },
  });

  return [create, list, get, update];
}
