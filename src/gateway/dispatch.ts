import { dispatch, type DispatchReceipt, type AgentDispatchRequest } from '@flue/runtime';
import { loadProjectContext } from '../agent/context';
import { resolveModel } from '../project/bindings';
import { decodeProjectDelivery } from '../agent/delivery';
import { addSafeMediaNotices, prepareVisionImages, type VisionPreparation } from '../slack/vision-media';
import type { D1Like } from '../skills/repository';

import { ProjectAdmissionError, projectDispatchMessage, type ProjectDispatchRequest } from './dispatch-message';
import { modelSupportsVision } from '../project/bindings';
import type { FrozenIngressRoute } from '../slack/ingress-store';
export type { ProjectDispatchRequest } from './dispatch-message';

// Application bound, not a native HTTP limit. Leave room for native admission IDs and tracing.
const NATIVE_PAYLOAD_MAX_BYTES = 11_500_000;
const NATIVE_TRANSPORT_HEADROOM = 4096;

/** Product input stays model-visible; only gateway-loaded context enters trusted attributes. */
export async function prepareProjectDispatch(env: Record<string, unknown>, request: ProjectDispatchRequest,
  options?: { expectedRoute: FrozenIngressRoute }): Promise<AgentDispatchRequest> {
  let prepared: AgentDispatchRequest;
  try {
    const snapshot = await loadProjectContext(env, request.id,
      options?.expectedRoute ? { persona: options.expectedRoute.persona, strictDb: true } : undefined);
    if (!snapshot.binding || snapshot.binding.status !== 'active') throw new ProjectAdmissionError('No active project binding');
    if (options?.expectedRoute) {
      const route = options.expectedRoute, binding = route.binding;
      if (!binding || route.instanceId !== request.id || snapshot.projectId !== binding.projectId || snapshot.slug !== 'default'
        || ['projectId','provider','externalAccountId','externalSpaceId','transportBotId','transportTokenRef'].some(
          key => snapshot.binding![key as keyof typeof binding] !== binding[key as keyof typeof binding])) {
        throw new ProjectAdmissionError('Frozen project route conflicts with current destination');
      }
      snapshot.persona = route.persona;
    }
    const model = resolveModel(snapshot.binding.model);
    const supportsVision = modelSupportsVision(model);
    const state = decodeProjectDelivery(request.id, projectDispatchMessage(request.id, request.input, snapshot, request.eventId));
    if (!state) throw new ProjectAdmissionError('Invalid project delivery context');
    const files = request.imageFiles ?? [];
    const token = env[snapshot.binding.transportTokenRef];
    const preparation: VisionPreparation = supportsVision && state.engaged && files.length
      ? env.DB ? await prepareVisionImages({ db: env.DB as D1Like, token: typeof token === 'string' ? token : undefined,
          projectId: snapshot.projectId, conversationId: state.conversationId, files })
        : { images: [], omissions: files.map(file => ({ fileId: file.id, reason: 'unavailable' })) }
      : { images: [], omissions: [] };
    for (;;) {
      const input = addSafeMediaNotices(request.input, preparation, supportsVision);
      prepared = {
        id: request.id,
        message: projectDispatchMessage(request.id, input, snapshot, request.eventId, preparation.images),
        // Context is a product-produced JSON snapshot; optional absent fields are omitted here.
        initialData: JSON.parse(JSON.stringify(snapshot)) as typeof snapshot,
        ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      };
      const bytes = new TextEncoder().encode(JSON.stringify({ agent: 'project', ...prepared })).length;
      if (bytes + NATIVE_TRANSPORT_HEADROOM <= NATIVE_PAYLOAD_MAX_BYTES) break;
      const dropped = preparation.images.pop();
      if (!dropped) throw new ProjectAdmissionError('Project input exceeds native payload limit');
      preparation.omissions.push({ fileId: dropped.fileId ?? '', reason: 'native-payload-limit' });
    }
  } catch (cause) {
    if (options?.expectedRoute || cause instanceof ProjectAdmissionError) throw cause;
    throw new ProjectAdmissionError(cause instanceof Error ? cause.message : 'Project context unavailable', { cause });
  }
  return prepared;
}
export async function dispatchPreparedProject(request: AgentDispatchRequest): Promise<DispatchReceipt> {
  const { Project } = await import('../agent/project');
  // A transport exception here may follow durable acceptance; never label it rejected.
  return dispatch(Project, request);
}
export async function dispatchProject(env: Record<string, unknown>, request: ProjectDispatchRequest): Promise<DispatchReceipt> {
  return dispatchPreparedProject(await prepareProjectDispatch(env, request));
}
