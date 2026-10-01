import type { AgentDispatchRequest } from '@flue/runtime';

/** Only failures before invoking native dispatch prove the input was not admitted. */
export class ProjectAdmissionError extends Error {}

export interface ProjectDispatchRequest {
  agent?: 'project';
  id: string;
  input: Record<string, unknown>;
  idempotencyKey?: string;
  eventId?: string;
}

/** Product input stays model-visible; only gateway-loaded context enters trusted attributes. */
export function projectDispatchMessage(input: Record<string, unknown>, snapshot: unknown, eventId?: string): AgentDispatchRequest['message'] {
  return {
    kind: 'signal',
    type: 'morehands.input',
    body: JSON.stringify(input),
    attributes: {
      snapshot: JSON.stringify(snapshot),
      input: JSON.stringify(input),
      engaged: typeof input.message === 'string' && input.kind !== 'heartbeat' ? 'true' : 'false',
      ...(typeof input.conversationId === 'string' ? { conversationId: input.conversationId } : {}),
      ...(typeof input.ackMessageTs === 'string' ? { ackMessageTs: input.ackMessageTs } : {}),
      ...(eventId ? { eventId } : {}),
    },
  };
}
