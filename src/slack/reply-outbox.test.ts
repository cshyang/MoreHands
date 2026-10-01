import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createTestRunner } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';
import { stageReply, deliverReplyPart, type ReplyTransport } from './reply-outbox';
import * as replies from './reply-outbox';
import { SlackApiError } from './post';

const { test, run } = createTestRunner();
const target = { projectId: 'P', agentSlug: 'default', conversationId: 'C', provider: 'slack' as const,
  externalAccountId: 'T', externalSpaceId: 'channel', externalConversationId: 'thread', transportTokenRef: 'TOKEN' };
function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../../migrations/0029_slack_reply_outbox.sql', import.meta.url), 'utf8'));
  const db: D1Like = { prepare: (query) => ({ bind: (...values) => ({
    run: async () => ({ meta: { changes: Number(sql.prepare(query).run(...values as never[]).changes) } }),
    first: async <T>() => (sql.prepare(query).get(...values as never[]) ?? null) as T | null,
    all: async <T>() => ({ results: sql.prepare(query).all(...values as never[]) as T[] }),
  }) }) };
  const calls: string[] = [];
  const wire: ReplyTransport = {
    edit: async (_token, _channel, ts) => { calls.push(`edit:${ts}`); },
    post: async (_token, _channel, _text, _thread, options) => { calls.push(`post:${options?.deliveryId}`); return 'posted'; },
    find: async () => null,
  };
  const state = () => sql.prepare('SELECT * FROM slack_reply_outbox ORDER BY part_index').all() as Array<Record<string, unknown>>;
  return { sql, db, wire, calls, state };
}
const input = { instanceId: 'i', responseId: 'r', target, text: 'Answer A\n\nAnswer B', now: 10 };
const id = 'i:r:0';

test('staging is atomic, replay-safe and keeps all answer parts', async () => {
  const f = fixture();
  await stageReply(f.db, input);
  await stageReply(f.db, input);
  assert.equal(f.state().length, 1);
  assert.equal(f.state()[0].text, input.text);
});
test('blank output stays silent', async () => {
  const f = fixture(); await stageReply(f.db, { ...input, text: '  ' }); assert.equal(f.state().length, 0);
});
test('a repeated edit after a lost response is safe', async () => {
  const f = fixture(); await stageReply(f.db, { ...input, editTs: 'ack' });
  f.sql.exec("UPDATE slack_reply_outbox SET status='sending',lease_until=20");
  assert.equal(await deliverReplyPart(f.db, { TOKEN: 'secret' }, id, { now: 21, transport: f.wire }), 'sent');
  assert.deepEqual(f.calls, ['edit:ack']);
});
test('a post accepted before a crash is reconciled, not repeated', async () => {
  const f = fixture(); await stageReply(f.db, input);
  f.sql.exec("UPDATE slack_reply_outbox SET status='sending',lease_until=20");
  f.wire.find = async () => 'already-posted';
  assert.equal(await deliverReplyPart(f.db, { TOKEN: 'secret' }, id, { now: 21, transport: f.wire }), 'sent');
  assert.equal(f.state()[0].posted_ts, 'already-posted'); assert.deepEqual(f.calls, []);
});
test('an unknown post outcome without positive evidence never reposts', async () => {
  const f = fixture(); await stageReply(f.db, input);
  f.wire.post = async () => { f.calls.push('post'); throw new Error('network lost'); };
  assert.equal(await deliverReplyPart(f.db, { TOKEN: 'secret' }, id, { now: 20, transport: f.wire }), 'uncertain');
  assert.equal(await deliverReplyPart(f.db, { TOKEN: 'secret' }, id, { now: 21, transport: f.wire }), 'uncertain');
  assert.deepEqual(f.calls, ['post']);
});
test('a definite Slack rejection can retry', async () => {
  const f = fixture(); await stageReply(f.db, input);
  f.wire.post = async () => { throw new SlackApiError('ratelimited'); };
  await assert.rejects(deliverReplyPart(f.db, { TOKEN: 'secret' }, id, { now: 20, transport: f.wire }), /ratelimited/);
  assert.equal(f.state()[0].status, 'pending');
});
test('concurrent deliverers claim once', async () => {
  const f = fixture(); await stageReply(f.db, input);
  const results = await Promise.all([1, 2].map(() => deliverReplyPart(f.db, { TOKEN: 'secret' }, id, { now: 20, transport: f.wire })));
  assert.equal(f.calls.length, 1); assert.ok(results.includes('waiting'));
});
test('chunk delivery is ordered and sent parts are not repeated', async () => {
  const f = fixture(); await stageReply(f.db, { ...input, text: 'A'.repeat(500), maxChars: 200 });
  assert.ok(f.state().length > 1);
  assert.equal(await deliverReplyPart(f.db, { TOKEN: 'secret' }, 'i:r:1', { now: 20, transport: f.wire }), 'waiting');
  await deliverReplyPart(f.db, { TOKEN: 'secret' }, id, { now: 20, transport: f.wire });
  await deliverReplyPart(f.db, { TOKEN: 'secret' }, id, { now: 21, transport: f.wire });
  await deliverReplyPart(f.db, { TOKEN: 'secret' }, 'i:r:1', { now: 21, transport: f.wire });
  assert.equal(f.calls.length, 2);
});
test('missing secrets fail before claiming or posting', async () => {
  const f = fixture(); await stageReply(f.db, input);
  await assert.rejects(deliverReplyPart(f.db, {}, id, { transport: f.wire }), /Missing transport token/);
  assert.equal(f.state()[0].status, 'pending'); assert.equal(f.calls.length, 0);
});
test('posts returning HTTP 5xx remain uncertain even with a JSON error body', async () => {
  const f = fixture(); await stageReply(f.db, input);
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ok: false, error: 'internal_error' }, { status: 503 });
  try {
    assert.equal(await deliverReplyPart(f.db, { TOKEN: 'secret' }, id, { now: 20 }), 'uncertain');
    assert.equal(f.state()[0].status, 'uncertain');
  } finally { globalThis.fetch = original; }
});
test('delivered chunks enter the transcript once and incomplete answers stay active', async () => {
  const f = fixture();
  f.sql.exec(readFileSync(new URL('../../migrations/0002_messages.sql', import.meta.url), 'utf8'));
  f.sql.exec(readFileSync(new URL('../../migrations/0031_messages_delivery_id.sql', import.meta.url), 'utf8'));
  f.sql.exec(readFileSync(new URL('../../migrations/0030_slack_reply_trackers.sql', import.meta.url), 'utf8'));
  f.sql.exec(readFileSync(new URL('../../migrations/0017_slack_turn_activity.sql', import.meta.url), 'utf8'));
  f.sql.exec(`ALTER TABLE slack_turn_activity ADD COLUMN doa_count INTEGER NOT NULL DEFAULT 0;
    INSERT INTO slack_turn_activity(project_id,session_id,conversation_id,slack_channel_id,slack_thread_ts,
      ack_message_ts,transport_token_ref,status,activities_json,created_at,updated_at)
    VALUES('P','conv:C','C','channel','thread','ack','TOKEN','active','[]',10,10);`);
  f.sql.prepare(`INSERT INTO slack_reply_trackers(instance_id,event_id,submission_id,target_json,ack_message_ts,publish,response_id,status,created_at,updated_at)
    VALUES('i','event','submission',?,'ack',1,'r','staged',10,10)`).run(JSON.stringify(target));
  await stageReply(f.db, { ...input, text: 'A'.repeat(500), maxChars: 200 });
  f.sql.exec("UPDATE slack_reply_outbox SET status='sent',posted_ts='first' WHERE part_index=0");
  await replies.finalizeDeliveredReplies(f.db, {});
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM messages').get()?.count, 1);
  assert.equal(f.sql.prepare('SELECT status FROM slack_reply_trackers').get()?.status, 'staged');
  assert.equal(f.sql.prepare('SELECT status FROM slack_turn_activity').get()?.status, 'active');
  f.sql.exec("UPDATE slack_reply_outbox SET status='sent',posted_ts='posted'");
  const original = globalThis.fetch;
  let edits = 0;
  globalThis.fetch = async (url) => {
    assert.equal(new URL(String(url)).pathname, '/api/chat.update');
    edits++;
    return Response.json({ ok: true });
  };
  try {
    await replies.finalizeDeliveredReplies(f.db, { TOKEN: 'local-test-token' });
    await replies.finalizeDeliveredReplies(f.db, { TOKEN: 'local-test-token' });
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS count FROM messages').get()?.count, f.state().length);
    assert.equal(f.sql.prepare('SELECT status FROM slack_reply_trackers').get()?.status, 'delivered');
    assert.equal(f.sql.prepare('SELECT status FROM slack_turn_activity').get()?.status, 'completed');
    assert.equal(edits, 1);
  } finally { globalThis.fetch = original; }
});
test('unresolved old posts do not starve newer pending replies', async () => {
  const f = fixture();
  for (let index = 0; index < 51; index++) await stageReply(f.db, { ...input, responseId: `r${index}` });
  f.sql.exec("UPDATE slack_reply_outbox SET status='uncertain' WHERE response_id!='r50'");
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes('chat.postMessage')
    ? Response.json({ ok: true, ts: 'new-post' }) : Response.json({ ok: true, messages: [] });
  try {
    await replies.deliverPendingReplies(f.db, { TOKEN: 'secret' });
    await replies.deliverPendingReplies(f.db, { TOKEN: 'secret' });
    assert.equal(f.sql.prepare("SELECT status FROM slack_reply_outbox WHERE response_id='r50'").get()?.status, 'sent');
  } finally { globalThis.fetch = original; }
});
test('instance-scoped delivery never posts another conversation answer', async () => {
  const f = fixture();
  await stageReply(f.db, input);
  await stageReply(f.db, { ...input, instanceId: 'other' });
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ok: true, ts: 'posted' });
  try {
    await replies.deliverPendingReplies(f.db, { TOKEN: 'secret' }, 'i');
    assert.equal(f.sql.prepare("SELECT status FROM slack_reply_outbox WHERE instance_id='i'").get()?.status, 'sent');
    assert.equal(f.sql.prepare("SELECT status FROM slack_reply_outbox WHERE instance_id='other'").get()?.status, 'pending');
  } finally { globalThis.fetch = original; }
});
test('malformed Slack JSON is an ambiguous outcome, not a definite rejection', async () => {
  const f = fixture(); await stageReply(f.db, input);
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({});
  try {
    assert.equal(await deliverReplyPart(f.db, { TOKEN: 'secret' }, id), 'uncertain');
    assert.equal(f.state()[0].status, 'uncertain');
  } finally { globalThis.fetch = original; }
});
test('chunks blocked behind an uncertain post do not starve other replies', async () => {
  const f = fixture();
  await stageReply(f.db, { ...input, text: 'A'.repeat(12_000), maxChars: 200 });
  assert.ok(f.state().length > 50);
  f.sql.exec("UPDATE slack_reply_outbox SET status='uncertain' WHERE part_index=0");
  await stageReply(f.db, { ...input, responseId: 'new', now: 11 });
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes('chat.postMessage')
    ? Response.json({ ok: true, ts: 'new-post' }) : Response.json({ ok: true, messages: [] });
  try {
    for (let pass = 0; pass < Math.ceil(f.state().length / 50) + 1; pass++) {
      await replies.deliverPendingReplies(f.db, { TOKEN: 'secret' });
    }
    assert.equal(f.sql.prepare("SELECT status FROM slack_reply_outbox WHERE response_id='new'").get()?.status, 'sent');
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS count FROM slack_reply_outbox WHERE response_id='r' AND status='sent'").get()?.count, 0);
  } finally { globalThis.fetch = original; }
});
test('terminal receipt repair survives a failed edit and stops after success', async () => {
  const f = fixture();
  for (const migration of ['0002_messages.sql', '0031_messages_delivery_id.sql',
    '0030_slack_reply_trackers.sql', '0017_slack_turn_activity.sql']) {
    f.sql.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'));
  }
  f.sql.exec(`INSERT INTO slack_turn_activity(project_id,session_id,conversation_id,slack_channel_id,
    slack_thread_ts,ack_message_ts,transport_token_ref,status,activities_json,created_at,updated_at)
    VALUES('P','conv:C','C','channel','thread','ack','TOKEN','active','[]',10,10);`);
  // A rejected admission also needs repair, despite having no native submission to replay.
  f.sql.prepare(`INSERT INTO slack_reply_trackers(instance_id,event_id,target_json,ack_message_ts,
    publish,status,outcome,created_at,updated_at) VALUES('i','rejected',?,'ack',1,'failed','failed',10,10)`)
    .run(JSON.stringify(target));
  let edits = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(new URL(String(url)).pathname, '/api/chat.update');
    edits++;
    if (edits === 1) throw new Error('receipt connection lost');
    return Response.json({ ok: true });
  };
  try {
    await assert.rejects(replies.finalizeDeliveredReplies(f.db, { TOKEN: 'local-test-token' }), /receipt connection lost/);
    await replies.finalizeDeliveredReplies(f.db, { TOKEN: 'local-test-token' });
    await replies.finalizeDeliveredReplies(f.db, { TOKEN: 'local-test-token' });
    assert.equal(edits, 2);
    assert.equal(f.sql.prepare('SELECT status FROM slack_turn_activity').get()?.status, 'failed');
    assert.equal(f.sql.prepare('SELECT status FROM slack_reply_trackers').get()?.status, 'failed');
    assert.equal(f.state().length, 0);
  } finally { globalThis.fetch = original; }
});
await run();
