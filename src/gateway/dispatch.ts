import { dispatch, type DispatchReceipt } from '@flue/runtime';
import { Project } from '../agent/project';
import { loadProjectContext } from '../agent/context';

import { ProjectAdmissionError, projectDispatchMessage, type ProjectDispatchRequest } from './dispatch-message';
export type { ProjectDispatchRequest } from './dispatch-message';

/** Product input stays model-visible; only gateway-loaded context enters trusted attributes. */
export async function dispatchProject(env: Record<string, unknown>, request: ProjectDispatchRequest): Promise<DispatchReceipt> {
  let prepared: Parameters<typeof dispatch>[1];
  try {
    const snapshot = await loadProjectContext(env, request.id);
    if (!snapshot.binding || snapshot.binding.status !== 'active') throw new Error('No active project binding');
    prepared = {
      id: request.id,
      message: projectDispatchMessage(request.input, snapshot, request.eventId),
      initialData: snapshot,
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
    };
  } catch (cause) {
    throw new ProjectAdmissionError(cause instanceof Error ? cause.message : 'Project context unavailable', { cause });
  }
  // A transport exception here may follow durable acceptance; never label it rejected.
  return dispatch(Project, prepared);
}
