// Shared pure payload builders for the local D1 ingress storage proof.
// No Node-only imports here: this module is bundled into the probe Worker.
import type { AgentDispatchRequest } from '@flue/runtime';
import type { ProjectContext } from '../../src/agent/context';
import { projectDispatchMessage } from '../../src/gateway/dispatch-message';
import type { FrozenIngressRoute } from '../../src/slack/ingress-store';

export const PROBE_INSTANCE_ID = 'project:P:agent:default@g2/conv:1.0';
/** Native application bound (11,500,000) minus the unchanged 4,096-byte reserve. */
export const NEAR_LIMIT_ENVELOPE_BYTES = 11_500_000 - 4096;

export const probeSnapshot: ProjectContext = {
  projectId: 'P', slug: 'default',
  binding: { projectId: 'P', provider: 'slack', externalAccountId: 'T', externalSpaceId: 'C',
    transportTokenRef: 'SLACK_BOT_TOKEN', transportBotId: 'B', sandboxMode: 'virtual', status: 'active', model: 'zai/glm-5.3-flash' },
  persona: null, catalog: [], personality: '世界🙂', memoryBlock: null,
  connections: { specs: [], enabledIntegrations: [] },
};

export function probeRouteFor(eventId: string): FrozenIngressRoute {
  return {
    mode: 'overhear', deliveryEventId: `T:${eventId}`, epoch: 0, instanceId: PROBE_INSTANCE_ID,
    target: { projectId: 'P', agentSlug: 'default', conversationId: '1.0', provider: 'slack',
      externalAccountId: 'T', externalSpaceId: 'C', externalConversationId: '1.0', transportTokenRef: 'SLACK_BOT_TOKEN' },
    binding: probeSnapshot.binding, persona: null, skipAck: true, overhearNow: '2026-10-04T00:00:00.000Z',
  };
}

export function probeTextRequest(eventId = 'E1'): AgentDispatchRequest {
  return { id: PROBE_INSTANCE_ID,
    message: projectDispatchMessage(PROBE_INSTANCE_ID, { message: '世界🙂 é', conversationId: '1.0' }, probeSnapshot, `T:${eventId}`),
    initialData: probeSnapshot, idempotencyKey: `slack:T:${eventId}` };
}

// '世🙂é' is 3+4+2 = 9 UTF-8 bytes per repetition; tails cover every remainder 0..8.
const UTF8_FILL = '世🙂é';
const UTF8_TAILS = ['', 'x', 'é', '世', '🙂', 'ééx', '世世', '世🙂', '🙂🙂'];

/** Builds a valid request whose full native envelope is exactly targetEnvelopeBytes of mixed UTF-8. */
export function utf8PaddedRequest(targetEnvelopeBytes = NEAR_LIMIT_ENVELOPE_BYTES): AgentDispatchRequest {
  if (!Number.isSafeInteger(targetEnvelopeBytes) || targetEnvelopeBytes < 0) throw new RangeError('Invalid target envelope bytes');
  const request = probeTextRequest();
  const initialData = { ...probeSnapshot, memoryBlock: '' };
  request.initialData = initialData;
  const encoder = new TextEncoder();
  const base = encoder.encode(JSON.stringify({ agent: 'project', ...request })).length;
  if (targetEnvelopeBytes < base) throw new RangeError('Target envelope below request minimum');
  const fill = targetEnvelopeBytes - base;
  initialData.memoryBlock = UTF8_FILL.repeat(Math.floor(fill / 9)) + UTF8_TAILS[fill % 9];
  const actual = encoder.encode(JSON.stringify({ agent: 'project', ...request })).length;
  if (actual !== targetEnvelopeBytes) throw new Error(`UTF-8 padding mismatch: ${actual} != ${targetEnvelopeBytes}`);
  return request;
}

/** The exact bytes storeFrozenRequest freezes (request JSON without the agent prefix). */
export function frozenRequestBytes(request: AgentDispatchRequest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(request));
}

/** Original provider bytes for a signed event_callback body, matching the local native-ingress fixture shape. */
export function probeEventRaw(eventId: string, text: string, root: string): string {
  return JSON.stringify({
    type: 'event_callback', team_id: 'T', event_id: eventId,
    event: { type: 'message', channel: 'C', user: 'U', ts: root, thread_ts: root, text },
  });
}
