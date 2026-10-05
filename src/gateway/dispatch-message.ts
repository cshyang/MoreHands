import type { DeliveredMessage } from '@flue/runtime';
import type { ProjectContext } from '../agent/context';
import type { ProjectUserEnvelope } from '../agent/delivery';
import type { SlackFileMeta } from '../slack/events';
import type { VisionImage } from '../slack/vision-media';

/** Explicit input/route rejection. Durable preparation lets unavailable reads remain retryable. */
export class ProjectAdmissionError extends Error {}

export interface ProjectDispatchRequest {
  agent?: 'project';
  id: string;
  input: Record<string, unknown>;
  idempotencyKey?: string;
  eventId?: string;
  /** Scoped file references; the gateway owns capability checks and byte preparation. */
  imageFiles?: SlackFileMeta[];
}

/** Gateway owns metadata. User-image envelopes also expose the serializable snapshot to the model. */
export function projectDispatchMessage(id: string, input: Record<string, unknown>, snapshot: ProjectContext, eventId?: string,
  images?: VisionImage[]): DeliveredMessage {
  const engaged = typeof input.message === 'string' && input.kind !== 'heartbeat';
  // Vision turns: real user input with image content rides the runtime's user-message
  // path, which persists canonical attachments and renders ImageContent blocks.
  if (engaged && images?.length) {
    const envelope: ProjectUserEnvelope = {
      format: 'morehands.project-input', version: 1, input,
      trusted: { instanceId: id, snapshot, engaged,
        conversationId: typeof input.conversationId === 'string' ? input.conversationId : '',
        ...(typeof input.ackMessageTs === 'string' ? { ackMessageTs: input.ackMessageTs } : {}),
        ...(eventId ? { eventId } : {}) },
    };
    return {
      kind: 'user',
      body: JSON.stringify(envelope),
      attachments: images.map((image) => ({
        type: 'image' as const,
        data: image.data,
        mimeType: image.mimeType,
        ...(image.filename ? { filename: image.filename } : {}),
      })),
    };
  }
  return {
    kind: 'signal',
    type: 'morehands.input',
    body: JSON.stringify(input),
    attributes: {
      snapshot: JSON.stringify(snapshot),
      input: JSON.stringify(input),
      engaged: engaged ? 'true' : 'false',
      ...(typeof input.conversationId === 'string' ? { conversationId: input.conversationId } : {}),
      ...(typeof input.ackMessageTs === 'string' ? { ackMessageTs: input.ackMessageTs } : {}),
      ...(eventId ? { eventId } : {}),
    },
  };
}
