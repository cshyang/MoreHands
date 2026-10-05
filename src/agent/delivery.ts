import type { DeliveredMessage } from '@flue/runtime';
import { parseAgentInstanceId } from '../project/bindings';
import { isEngagedProjectInput, parseProjectDispatchInput, projectContextForDelivery, type ProjectContext } from './context';

export interface ProjectDeliveryState {
  context: ProjectContext;
  input: Record<string, unknown>;
  engaged: boolean;
  eventId?: string;
  conversationId: string;
  ackMessageTs?: string;
}
export interface ProjectUserEnvelope {
  format: 'morehands.project-input';
  version: 1;
  trusted: {
    instanceId: string;
    snapshot: ProjectContext;
    engaged: boolean;
    eventId?: string;
    conversationId: string;
    ackMessageTs?: string;
  };
  input: Record<string, unknown>;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}
function validContext(context: ProjectContext): boolean {
  const binding = context.binding;
  return !!binding && binding.provider === 'slack' && binding.status === 'active'
    && ['externalAccountId', 'externalSpaceId', 'transportBotId', 'transportTokenRef'].every(key =>
      typeof Reflect.get(binding, key) === 'string' && Reflect.get(binding, key).length > 0)
    && optionalString(binding.model)
    && (context.personality === null || typeof context.personality === 'string')
    && (context.memoryBlock === null || typeof context.memoryBlock === 'string')
    && (context.persona === null || object(context.persona))
    && context.catalog.every(item => object(item) && typeof item.name === 'string' && typeof item.description === 'string')
    && context.connections.specs.every(item => object(item))
    && context.connections.enabledIntegrations.every(item => object(item)
      && ['uniqueKey', 'provider', 'displayName'].every(key => typeof item[key] === 'string'));
}
function validConversation(id: string, context: ProjectContext, conversationId: string, engaged: boolean): boolean {
  const scope = parseAgentInstanceId(id).scope;
  if (engaged && scope && scope.replace(/~e\d+$/, '') !== `conv:${conversationId}`) return false;
  if (conversationId.startsWith('slack:')) {
    const prefix = `slack:${context.binding!.externalAccountId}:${context.binding!.externalSpaceId}:`;
    if (!conversationId.startsWith(prefix) || conversationId.length === prefix.length) return false;
  }
  return true;
}

/** The private producer boundary authenticates admission; this decoder validates its contract. */
export function decodeProjectDelivery(id: string, delivery: DeliveredMessage, initial?: ProjectContext): ProjectDeliveryState | null {
  if (!object(delivery) || typeof delivery.body !== 'string') return null;
  let input: Record<string, unknown> | null;
  let context: ProjectContext | null;
  let engaged: boolean;
  let eventId: unknown;
  let conversationId: unknown;
  let ackMessageTs: unknown;
  if (delivery.kind === 'signal') {
    if (delivery.type !== 'morehands.input') return null;
    const attrs = delivery.attributes;
    if (attrs?.engaged !== undefined && attrs.engaged !== 'true' && attrs.engaged !== 'false') return null;
    input = parseProjectDispatchInput(attrs?.input ?? delivery.body);
    context = projectContextForDelivery(id, attrs?.snapshot, initial);
    engaged = isEngagedProjectInput(attrs, input);
    eventId = attrs?.eventId;
    conversationId = attrs?.conversationId ?? input?.conversationId ?? '';
    ackMessageTs = attrs?.ackMessageTs ?? input?.ackMessageTs;
  } else if (delivery.kind === 'user') {
    const envelope = parseProjectDispatchInput(delivery.body);
    if (!envelope || envelope.format !== 'morehands.project-input' || envelope.version !== 1
      || !object(envelope.trusted) || !object(envelope.input)) return null;
    const trusted = envelope.trusted;
    if (trusted.instanceId !== id || typeof trusted.engaged !== 'boolean' || !trusted.engaged) return null;
    context = projectContextForDelivery(id, JSON.stringify(trusted.snapshot), undefined);
    input = envelope.input;
    engaged = trusted.engaged;
    eventId = trusted.eventId; conversationId = trusted.conversationId; ackMessageTs = trusted.ackMessageTs;
    if (typeof input.message !== 'string' || input.kind === 'heartbeat') return null;
  } else return null;
  if (!input || !context || !validContext(context) || typeof conversationId !== 'string'
    || !optionalString(eventId) || !optionalString(ackMessageTs)
    || !validConversation(id, context, conversationId, engaged)) return null;
  if (delivery.kind === 'user' && (!conversationId || input.conversationId !== conversationId
    || input.ackMessageTs !== ackMessageTs)) return null;
  return { context, input, engaged, conversationId,
    ...(eventId ? { eventId } : {}), ...(ackMessageTs ? { ackMessageTs } : {}) };
}
export function projectEventId(id: string, delivery: DeliveredMessage): string | undefined {
  if (!object(delivery)) return undefined;
  // Durable native signal attributes predate the current render contract.
  if (delivery.kind === 'signal') {
    return typeof delivery.attributes?.eventId === 'string' ? delivery.attributes.eventId : undefined;
  }
  return decodeProjectDelivery(id, delivery)?.eventId;
}
