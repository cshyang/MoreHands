// Native dispatch envelope invariants — run: npx tsx src/gateway/dispatch.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { projectDispatchMessage } from './dispatch-message';
import { agentInstanceId } from '../project/bindings';
import { conversationScope } from '../project/conversations';

const { test, run } = createTestRunner();
const signal = (input: Record<string, unknown>, snapshot: unknown = {}, eventId?: string) =>
  projectDispatchMessage(input, snapshot, eventId) as { kind: string; type: string; body: string; attributes: Record<string, string> };

test('preserves every dispatch family as native signal JSON and trusted input', () => {
  const inputs = [
    { message: 'hello', conversationId: 'slack:T:C:1', senderId: 'U', ackMessageTs: '2', threadContext: 'backscroll', attachedFiles: [{ id: 'F' }] },
    { kind: 'heartbeat', now: '2026-10-01', skill: 'reminder', instructions: 'scheduled work' },
    { kind: 'heartbeat', now: '2026-10-01', instructions: 'reflect and consolidate' },
    { kind: 'heartbeat', now: '2026-10-01', instructions: 'review ambient messages' },
    { kind: 'work_item', workItemId: 'W', title: 'Investigate', body: 'details' },
  ];
  const snapshot = { binding: { projectId: 'P' }, persona: { name: 'Local' } };
  for (const input of inputs) {
    const message = signal(input, snapshot);
    assert.equal(message.kind, 'signal');
    assert.equal(message.type, 'morehands.input');
    assert.deepEqual(JSON.parse(message.body), input);
    assert.deepEqual(JSON.parse(message.attributes.input), input);
    assert.deepEqual(JSON.parse(message.attributes.snapshot), snapshot);
    assert.equal(message.attributes.engaged, 'message' in input ? 'true' : 'false');
  }
});

test('only direct user input engages; reminders, overhear, reflection and review stay quiet', () => {
  assert.equal(signal({ message: 'hello' }).attributes.engaged, 'true');
  for (const family of ['scheduled', 'overhear', 'reflect', 'review']) {
    assert.equal(signal({ kind: 'heartbeat', message: 'background context', instructions: family }).attributes.engaged, 'false');
  }
});

test('nested untrusted attributes cannot replace trusted context or destination', () => {
  const input = { snapshot: { binding: { projectId: 'OTHER' } }, attributes: { admin: 'true', conversationId: 'OTHER' }, conversationId: 'slack:T:C:1', ackMessageTs: '2' };
  const message = signal(input, { binding: { projectId: 'P' } });
  assert.equal(message.attributes.snapshot, JSON.stringify({ binding: { projectId: 'P' } }));
  assert.equal(message.attributes.conversationId, 'slack:T:C:1');
  assert.equal(message.attributes.ackMessageTs, '2');
  assert.equal(message.attributes.admin, undefined);
});

test('durable tracker correlation comes from gateway metadata, not input attributes', () => {
  const message = signal({ eventId: 'spoofed', attributes: { eventId: 'spoofed' } }, {}, 'verified-event');
  assert.equal(message.attributes.eventId, 'verified-event');
});

test('native instance IDs partition destinations, epochs and quiet dispatch families', () => {
  const scopes = [
    conversationScope('slack:T:C:1', 0), conversationScope('slack:T:C:2', 0),
    conversationScope('slack:T:C:1', 1), conversationScope('slack:T:D:1', 0),
    'job:J', 'reflect:1', 'review:1', 'overhear:1', 'work:W',
  ];
  const ids = scopes.flatMap((scope) => ['P', 'Q'].map((project) => agentInstanceId(project, scope)));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(agentInstanceId('P', scopes[0]), agentInstanceId('P', conversationScope('slack:T:C:1', 0)));
});

await run();
