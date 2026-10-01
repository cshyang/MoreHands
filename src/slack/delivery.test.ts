import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createTestRunner } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';
import type { ConversationRecord } from '@flue/runtime/adapter';
import { seedReplyTracker, attachReplySubmission, reconcileReplyHistory, type ReplyHistory } from './delivery';

const { test, run } = createTestRunner();
const target = { projectId: 'P', agentSlug: 'default', conversationId: 'C', provider: 'slack' as const,
  externalAccountId: 'T', externalSpaceId: 'channel', externalConversationId: 'thread', transportTokenRef: 'TOKEN' };
function fixture() {
  const sql = new DatabaseSync(':memory:');
  for (const name of ['0029_slack_reply_outbox.sql', '0030_slack_reply_trackers.sql']) {
    sql.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
  }
  const db: D1Like = { prepare: (query) => ({ bind: (...values) => ({
    run: async () => sql.prepare(query).run(...values as never[]),
    first: async <T>() => (sql.prepare(query).get(...values as never[]) ?? null) as T | null,
    all: async <T>() => ({ results: sql.prepare(query).all(...values as never[]) as T[] }),
  }) }) };
  const replies = () => sql.prepare('SELECT * FROM slack_reply_outbox ORDER BY created_at,part_index').all() as Array<Record<string, unknown>>;
  return { db, sql, replies };
}
let sequence = 0;
function record(type: string, fields: Record<string, unknown> = {}): ConversationRecord {
  return { v: 1, id: `record-${++sequence}`, type, conversationId: 'root', harness: 'default', session: 'default',
    timestamp: '2026-10-01T00:00:00Z', submissionId: 'host', attemptId: 'attempt', ...fields } as ConversationRecord;
}
function step(messageId: string, text: string, options: { tool?: boolean; error?: boolean; child?: boolean; incomplete?: boolean } = {}) {
  const fields = { messageId, ...(options.child ? { conversationId: 'child', harness: 'delegate' } : {}) };
  return [record('assistant_message_started', fields), record('assistant_text_started', { ...fields, blockId: messageId, blockIndex: 0 }),
    record('assistant_text_delta', { ...fields, blockId: messageId, sequence: 0, delta: text }),
    ...(options.tool ? [record('assistant_tool_call', { ...fields, toolCallId: 'tool', name: 'lookup', blockId: 'tool', blockIndex: 1, arguments: {} })] : []),
    ...(options.incomplete ? [] : [record('assistant_message_completed', { ...fields, stopReason: options.error ? 'error' : options.tool ? 'toolUse' : 'stop', ...(options.error ? { error: 'provider error' } : {}) })])];
}
function history(records: ConversationRecord[], incarnation = 'generation'): ReplyHistory {
  return { getMeta: async () => ({ incarnation }), read: async (_path, { offset } = {}) => {
    const start = offset === '-1' || offset === undefined ? 0 : Number(offset!.split('_')[1]) + 1;
    const page = records.slice(start, start + 2);
    return { batches: page.map((r, i) => ({ offset: `0_${start + i}`, records: [r] })),
      nextOffset: `0_${start + page.length - 1}`, upToDate: start + page.length >= records.length };
  } };
}
const signal = (eventId = 'event', submissionId = 'host') => record('signal', { id: `record_dispatch_input_${submissionId}`, messageId: eventId, submissionId, attributes: { eventId }, signalType: 'slack.message', content: 'question', parentId: null });
const settle = (submissionId = 'host', outcome = 'completed') => record('submission_settled', { submissionId, outcome });
async function seed(f: ReturnType<typeof fixture>, publish = true) {
  await seedReplyTracker(f.db, { instanceId: 'instance', eventId: 'event', target, ackMessageTs: 'ack', publish, now: 1 });
}

test('restart recovers every completed no-tool answer and excludes narration, reasoning and delegates', async () => {
  const f = fixture(); await seed(f);
  const records = [signal(), ...step('narration', 'Never publish', { tool: true }), ...step('first', 'Answer A'),
    record('assistant_reasoning_delta', { messageId: 'first', blockId: 'reasoning', sequence: 0, delta: 'private thought' }),
    ...step('child', 'Delegate secret', { child: true }), ...step('second', 'Answer B'), settle()];
  await reconcileReplyHistory(f.db, 'instance', history(records));
  assert.equal(f.replies().length, 1); assert.equal(f.replies()[0].text, 'Answer A\n\nAnswer B');
  assert.equal(f.replies()[0].edit_ts, null);
});
test('joined submissions stage a single host reply under repeated reconciliation', async () => {
  const f = fixture(); await seed(f);
  await seedReplyTracker(f.db, { instanceId: 'instance', eventId: 'joined-event', target, publish: true });
  await attachReplySubmission(f.db, { instanceId: 'instance', eventId: 'joined-event', submissionId: 'joined' });
  const h = history([signal(), signal('joined-event', 'joined'), ...step('one', 'All answers'), settle('joined'), settle()]);
  await reconcileReplyHistory(f.db, 'instance', h); await reconcileReplyHistory(f.db, 'instance', h);
  assert.equal(f.replies().length, 1); assert.equal(f.replies()[0].response_id, 'generation:host');
});
test('native signal heals a crash before receipt attachment', async () => {
  const f = fixture(); await seed(f);
  await reconcileReplyHistory(f.db, 'instance', history([signal(), ...step('one', 'Recovered'), settle()]));
  const row = f.sql.prepare('SELECT submission_id,status FROM slack_reply_trackers').get();
  assert.equal(row?.submission_id, 'host'); assert.equal(row?.status, 'staged');
});
test('durable admission heals receipt attachment before any canonical input exists', async () => {
  const f = fixture(); await seed(f);
  const h = Object.assign(history([settle('host', 'aborted')]), {
    admissions: async () => [{ eventId: 'event', submissionId: 'host', unreadyTerminal: false }],
  });
  const result = await reconcileReplyHistory(f.db, 'instance', h);
  assert.equal(f.sql.prepare('SELECT submission_id,status FROM slack_reply_trackers').get()?.submission_id, 'host');
  assert.equal(result[0]?.outcome, 'aborted');
  assert.equal(f.replies().length, 0);
});
test('unclaimable settled admission closes as failure without pretending it produced an answer', async () => {
  const f = fixture(); await seed(f);
  const h = Object.assign(history([]), { getMeta: async () => null,
    admissions: async () => [{ eventId: 'event', submissionId: 'host', unreadyTerminal: true }],
  });
  await reconcileReplyHistory(f.db, 'instance', h);
  assert.equal(f.sql.prepare('SELECT status FROM slack_reply_trackers').get()?.status, 'failed');
  assert.equal(f.replies().length, 0);
});
test('silent autonomous text never stages a reply', async () => {
  const f = fixture(); await seed(f, false);
  await reconcileReplyHistory(f.db, 'instance', history([signal(), ...step('one', 'Internal reflection'), settle()]));
  assert.equal(f.replies().length, 0);
});
test('failed and incomplete steps are not included in a successful response', async () => {
  const f = fixture(); await seed(f);
  await reconcileReplyHistory(f.db, 'instance', history([signal(), ...step('bad', 'Broken', { error: true }),
    ...step('partial', 'Partial', { incomplete: true }), ...step('good', 'Good'), settle()]));
  assert.equal(f.replies()[0].text, 'Good');
});
test('failed settlement never publishes completed earlier answers', async () => {
  const f = fixture(); await seed(f);
  const results = await reconcileReplyHistory(f.db, 'instance', history([signal(), ...step('one', 'Earlier'), settle('host', 'failed')]));
  assert.equal(f.replies().length, 0); assert.equal(results[0].outcome, 'failed');
});
test('no settlement means no premature delivery', async () => {
  const f = fixture(); await seed(f);
  await reconcileReplyHistory(f.db, 'instance', history([signal(), ...step('one', 'Not settled')]));
  assert.equal(f.replies().length, 0);
});
test('staging before tracker completion survives a crash without duplicate outbox rows', async () => {
  const f = fixture(); await seed(f);
  const h = history([signal(), ...step('one', 'Answer'), settle()]);
  await reconcileReplyHistory(f.db, 'instance', h);
  f.sql.exec("UPDATE slack_reply_trackers SET status='pending'");
  await reconcileReplyHistory(f.db, 'instance', h);
  assert.equal(f.replies().length, 1);
});
test('a settled response with empty text is terminal without a fabricated answer', async () => {
  const f = fixture(); await seed(f);
  const results = await reconcileReplyHistory(f.db, 'instance', history([signal(), ...step('one', '  '), settle()]));
  assert.equal(f.replies().length, 0); assert.equal(results[0].status, 'empty');
});
test('framework instruction signals do not change the admitted delivery publish mode', async () => {
  const f = fixture(); await seed(f);
  await reconcileReplyHistory(f.db, 'instance', history([signal(),
    record('signal', { messageId: 'resources', signalType: 'resources', content: 'tools changed' }),
    ...step('one', 'Answer'), settle()]));
  assert.equal(f.replies()[0].text, 'Answer');
});
test('a silent delivery joining an engaged response never leaks its internal text', async () => {
  const f = fixture(); await seed(f);
  await seedReplyTracker(f.db, { instanceId: 'instance', eventId: 'silent-event', target, publish: false });
  await reconcileReplyHistory(f.db, 'instance', history([signal(), ...step('one', 'Public answer'),
    signal('silent-event', 'silent'), record('signal', { messageId: 'resources', signalType: 'resources', content: 'tools changed' }),
    ...step('two', 'Internal notes'), settle('silent'), settle()]));
  assert.equal(f.replies().length, 1); assert.equal(f.replies()[0].text, 'Public answer');
});
test('recovery consumes actual Flue canonical batches after an observer-free restart', async () => {
  const { InMemoryConversationStreamStore, agentStreamPath } = await import('@flue/runtime/internal');
  const store = new InMemoryConversationStreamStore();
  const instanceId = 'project:P:agent:default/conv:slack:T:C:1@g2';
  const path = agentStreamPath('project', instanceId);
  await store.createStream(path, { agentName: 'project', instanceId });
  const claim = await store.acquireProducer(path, 'producer');
  await store.append({ path, producerId: 'producer', producerEpoch: claim.producerEpoch,
    incarnation: claim.incarnation, producerSequence: claim.nextProducerSequence,
    submission: { submissionId: 'host', attemptId: 'attempt' },
    records: [signal(), ...step('tool', 'Do not publish', { tool: true }), ...step('answer', 'Recovered from Flue'), settle()] });
  const f = fixture();
  await seedReplyTracker(f.db, { instanceId, eventId: 'event', target, ackMessageTs: 'ack', publish: true });
  await reconcileReplyHistory(f.db, instanceId, store);
  assert.equal(f.replies()[0].text, 'Recovered from Flue');
});
test('late tracker seeding recovers a previously unmapped settled response', async () => {
  const f = fixture(); const h = history([signal(), ...step('one', 'Late mapping'), settle()]);
  await reconcileReplyHistory(f.db, 'instance', h); assert.equal(f.replies().length, 0);
  await seed(f); await reconcileReplyHistory(f.db, 'instance', h); assert.equal(f.replies()[0].text, 'Late mapping');
});
test('delivered trackers remain delivered after full history replay', async () => {
  const f = fixture(); await seed(f);
  const h = history([signal(), ...step('one', 'Answer'), settle()]);
  await reconcileReplyHistory(f.db, 'instance', h);
  f.sql.exec("UPDATE slack_reply_trackers SET status='delivered'");
  const results = await reconcileReplyHistory(f.db, 'instance', h);
  assert.equal(f.sql.prepare('SELECT status FROM slack_reply_trackers').get()?.status, 'delivered');
  assert.equal(results.length, 0); assert.equal(f.replies().length, 1);
});
test('a quiet admitted signal during an unfinished step suppresses that whole step', async () => {
  const f = fixture(); await seed(f);
  await seedReplyTracker(f.db, { instanceId: 'instance', eventId: 'silent-event', target, publish: false });
  const interrupted = step('mixed', 'Public prefix');
  await reconcileReplyHistory(f.db, 'instance', history([signal(), ...step('first', 'Safe answer'),
    ...interrupted.slice(0, -1), signal('silent-event', 'silent'),
    record('assistant_text_delta', { messageId: 'mixed', blockId: 'mixed', sequence: 1, delta: ' private suffix' }),
    interrupted.at(-1)!, settle('silent'), settle()]));
  assert.equal(f.replies()[0].text, 'Safe answer');
});
test('joined deliveries to different conversations never publish a combined answer', async () => {
  const f = fixture(); await seed(f);
  await seedReplyTracker(f.db, { instanceId: 'instance', eventId: 'other-event',
    target: { ...target, conversationId: 'other', externalSpaceId: 'other-channel' }, publish: true });
  const h = history([signal(), signal('other-event', 'other'), ...step('one', 'Combined sensitive answer'), settle('other'), settle()]);
  await assert.rejects(reconcileReplyHistory(f.db, 'instance', h), /different conversation targets/);
  assert.equal(f.replies().length, 0);
});
test('native response projection retains completed checkpoints across recovered attempts', async () => {
  const { InMemoryConversationStreamStore, agentStreamPath, readSubmissionReply } = await import('@flue/runtime/internal');
  const store = new InMemoryConversationStreamStore();
  const path = agentStreamPath('project', 'instance');
  await store.createStream(path, { agentName: 'project', instanceId: 'instance' });
  const producer = await store.acquireProducer(path, 'producer');
  const completeStep = (id: string, text: string, parentId: string, attemptId: string) => {
    const records = step(id, text).map((r) => ({ ...r, attemptId } as ConversationRecord));
    records[0] = { ...records[0], parentId, modelInfo: { api: 'openai-completions', provider: 'zai', model: 'glm-5.3-flash' } } as ConversationRecord;
    records.splice(-1, 0, record('assistant_text_completed', { messageId: id, blockId: id, deltaCount: 1, attemptId }));
    return records;
  };
  await store.append({ path, producerId: 'producer', producerEpoch: producer.producerEpoch,
    incarnation: producer.incarnation, producerSequence: producer.nextProducerSequence,
    submission: { submissionId: 'host', attemptId: 'attempt' }, records: [
      record('conversation_created', { kind: 'root', affinityKey: 'root', createdAt: '2026-10-01T00:00:00Z' }),
      { ...signal(), messageId: 'entry_event' } as ConversationRecord,
      ...completeStep('entry_old', 'Durable answer A', 'entry_event', 'attempt'),
    ] });
  const resumed = await store.acquireProducer(path, 'resumed');
  await store.append({ path, producerId: 'resumed', producerEpoch: resumed.producerEpoch,
    incarnation: resumed.incarnation, producerSequence: resumed.nextProducerSequence,
    submission: { submissionId: 'host', attemptId: 'recovered' }, records: [
      ...completeStep('entry_new', 'Continued answer B', 'entry_old', 'recovered'),
      record('submission_settled', { outcome: 'completed', attemptId: 'recovered' }),
    ] });
  // This is an upstream durable projection oracle, not a simulated process crash.
  const nativeReply = await readSubmissionReply({ store, path, submissionId: 'host' });
  assert.equal(nativeReply.text, 'Durable answer A\n\nContinued answer B');
  const f = fixture(); await seed(f);
  await reconcileReplyHistory(f.db, 'instance', store);
  assert.equal(f.replies()[0].text, 'Durable answer A\n\nContinued answer B');
});
for (const mode of ['failed', 'empty', 'silent'] as const) {
  test(`joined ${mode} receipt effects retain each admitted acknowledgement`, async () => {
    const f = fixture(); await seed(f, mode !== 'silent');
    const joinedTarget = mode === 'silent' ? { ...target, conversationId: 'other' } : target;
    await seedReplyTracker(f.db, { instanceId: 'instance', eventId: 'joined-event', target: joinedTarget,
      ackMessageTs: 'successor-ack', publish: mode !== 'silent' });
    const h = history([signal(), signal('joined-event', 'joined'), ...step('one', ' '),
      settle('joined', mode === 'failed' ? 'failed' : 'completed'), settle('host', mode === 'failed' ? 'failed' : 'completed')]);
    const results = await reconcileReplyHistory(f.db, 'instance', h);
    assert.equal(results.find((r) => r.submissionId === 'host')?.ackMessageTs, 'ack');
    const joined = results.find((r) => r.submissionId === 'joined');
    assert.equal(joined?.ackMessageTs, 'successor-ack');
    assert.deepEqual(joined?.target, joinedTarget);
    assert.equal(joined?.status, mode); assert.equal(f.replies().length, 0);
  });
}
await run();
