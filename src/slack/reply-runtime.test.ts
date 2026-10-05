import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import type { D1Like } from '../skills/repository';
import type { ConversationRecord } from '@flue/runtime/adapter';
import { createTestRunner } from '../shared/test-utils';
import { seedReplyTracker, attachReplySubmission } from './delivery';
import { stageReply } from './reply-outbox';

// Only the virtual Worker module is stubbed; use the installed Flue generated class,
// coordinator and SQLite canonical store, rather than mocking the history reducer.
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return {
    url: 'data:text/javascript,export const env={};export class DurableObject{};', shortCircuit: true,
  };
  return next(specifier, context);
} });
const { replyRuntime } = await import('./reply-runtime');
const { createFlueAgentClass } = await import('@flue/runtime/cloudflare/internal');
const { createCloudflareAgentRuntime, createFlueContext, SqliteConversationStreamStore, agentStreamPath,
  configureFlueRuntime, registerFlueAgents, resolveModel, setProvider } = await import('@flue/runtime/internal');
const { dispatch, useModel } = await import('@flue/runtime');
const { fauxProvider, fauxAssistantMessage } = await import('@earendil-works/pi-ai');
hook.deregister();
const { test, run } = createTestRunner();
const target = { projectId: 'P', agentSlug: 'default', conversationId: 'C', provider: 'slack' as const,
  externalAccountId: 'T', externalSpaceId: 'channel', externalConversationId: 'thread', transportTokenRef: 'TOKEN' };

function fixture(agent?: () => string, env: Record<string, unknown> = {}) {
  const native = new DatabaseSync(':memory:');
  const product = new DatabaseSync(':memory:');
  for (const name of ['0002_messages.sql', '0017_slack_turn_activity.sql', '0029_slack_reply_outbox.sql',
    '0030_slack_reply_trackers.sql', '0031_messages_delivery_id.sql']) {
    product.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
  }
  product.exec('ALTER TABLE slack_turn_activity ADD COLUMN doa_count INTEGER NOT NULL DEFAULT 0');
  const fibers: Promise<unknown>[] = [];
  const jobs: Promise<unknown>[] = [];
  native.exec('CREATE TABLE test_schedules(delay INTEGER,callback TEXT)');
  const storage = {
    getAlarm: async () => null,
    get: async () => undefined,
    sql: { exec(query: string, ...values: unknown[]) {
      const statement = native.prepare(query);
      const rows = statement.columns().length ? statement.all(...values as never[]) : (statement.run(...values as never[]), []);
      return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    } },
    transactionSync<T>(fn: () => T): T {
      native.exec('SAVEPOINT test_tx');
      try { const value = fn(); native.exec('RELEASE test_tx'); return value; }
      catch (error) { native.exec('ROLLBACK TO test_tx; RELEASE test_tx'); throw error; }
    },
  };
  const db: D1Like = { prepare: (query) => ({ bind: (...values) => ({
    run: async () => ({ meta: { changes: Number(product.prepare(query).run(...values as never[]).changes) } }),
    first: async <T>() => (product.prepare(query).get(...values as never[]) ?? null) as T | null,
    all: async <T>() => ({ results: product.prepare(query).all(...values as never[]) as T[] }),
  }) }) };
  class FakeAgent {
    name = 'instance';
    state = {};
    constructor(public ctx: any, public env: Record<string, unknown>) {}
    setState(value: {}) { this.state = value; }
    async onStart() {}
    async schedule(delay: number, callback: string) {
      native.prepare('INSERT INTO test_schedules VALUES (?,?)').run(delay, callback);
    }
    runFiber<T>(_name: string, fn: (context: { stash(snapshot: unknown): void }) => Promise<T>) {
      const running = fn({ stash() {} });
      fibers.push(running.catch(() => {}));
      return running;
    }
    async alarm() {
      const schedule = native.prepare('SELECT rowid,callback FROM test_schedules ORDER BY delay,rowid LIMIT 1').get();
      if (schedule) {
        await (this as any)[String(schedule.callback)]();
        native.prepare('DELETE FROM test_schedules WHERE rowid=?').run(schedule.rowid as number);
      }
    }
  }
  const runtime = createCloudflareAgentRuntime({ agents: agent ? [{ name: 'project', agent }] : [],
    createContext: ({ instance, agentName, request, submissionId }) => createFlueContext({
      id: instance.name, agentName, req: request, submissionId, env: instance.env ?? {}, agentConfig: { resolveModel },
    }), runWithInstanceContext: (_instance, _name, callback) => callback() });
  const Generated = createFlueAgentClass({ AgentBase: FakeAgent as any, runtime,
    className: 'FlueProjectAgent', agentName: 'project', extension: replyRuntime });
  const ctx = { storage, id: { toString: () => 'object-id' }, waitUntil(job: Promise<unknown>) { jobs.push(job); } };
  const restart = () => new Generated(ctx, { DB: db, ...env }) as any;
  const instance = restart();
  const history = new SqliteConversationStreamStore(storage.sql as any, (fn) => storage.transactionSync(fn));
  const schedules = () => native.prepare('SELECT delay,callback FROM test_schedules').all();
  const replies = () => product.prepare('SELECT text FROM slack_reply_outbox').all();
  const seed = () => seedReplyTracker(db, { instanceId: 'instance', eventId: 'event', target, publish: true });
  const activity = (ack = 'ack') => product.prepare(`INSERT INTO slack_turn_activity
    (project_id,session_id,conversation_id,slack_channel_id,slack_thread_ts,ack_message_ts,
      transport_token_ref,status,activities_json,created_at,updated_at)
    VALUES('P','conv:C','C','channel','thread',?,'TOKEN','active','[]',10,10)`).run(ack);
  const persist = async () => {
    const path = agentStreamPath('project', 'instance');
    await history.createStream(path, { agentName: 'project', instanceId: 'instance' });
    const producer = await history.acquireProducer(path, 'native-producer');
    // Mirror the native running attempt fence; SQLite correctly rejects owned
    // records without the matching execution-store authorization.
    native.prepare(`INSERT INTO flue_agent_submissions
      (submission_id,session_key,kind,payload,status,accepted_at,attempt_id)
      VALUES (?,?,?,?,?,?,?)`).run('host', 'agent-session:["project","instance","default","default"]',
        'dispatch', '{}', 'running', 1, 'attempt');
    const common = { v: 1, conversationId: 'root', harness: 'default', session: 'default',
      timestamp: '2026-10-01T00:00:00Z', submissionId: 'host', attemptId: 'attempt' };
    const records = [
      { ...common, id: 'record_dispatch_input_host', type: 'signal', messageId: 'event', attributes: { eventId: 'event' }, signalType: 'slack.message', content: 'question', parentId: null },
      { ...common, id: 'started', type: 'assistant_message_started', messageId: 'answer' },
      { ...common, id: 'text-started', type: 'assistant_text_started', messageId: 'answer', blockId: 'text', blockIndex: 0 },
      { ...common, id: 'delta', type: 'assistant_text_delta', messageId: 'answer', blockId: 'text', sequence: 0, delta: 'Native recovered answer' },
      { ...common, id: 'complete', type: 'assistant_message_completed', messageId: 'answer', stopReason: 'stop' },
      { ...common, id: 'settled', type: 'submission_settled', outcome: 'completed' },
    ] as ConversationRecord[];
    await history.append({ path, producerId: 'native-producer', producerEpoch: producer.producerEpoch,
      incarnation: producer.incarnation, producerSequence: producer.nextProducerSequence,
      submission: { submissionId: 'host', attemptId: 'attempt' }, records });
    native.prepare("UPDATE flue_agent_submissions SET status='settled' WHERE submission_id='host'").run();
  };
  const admit = async (eventId: string) => {
    if (!agent) throw new Error('Canary agent required');
    registerFlueAgents([{ identity: 'project', agent }]);
    configureFlueRuntime({ target: 'cloudflare', instanceInfo: async () => null, routeAgentRequest: async () => null,
      dispatchQueue: { enqueue: async (input) => {
        const response = await instance.onRequest(new Request('https://internal/__flue/internal/dispatch', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
        }));
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
      } } });
    return dispatch(agent, { id: 'instance', idempotencyKey: eventId,
      message: { kind: 'signal', type: 'slack.message', body: 'question', attributes: { eventId } } });
  };
  const idle = async () => { await Promise.all(fibers); await Promise.all(jobs); };
  const records = async () => (await history.read(agentStreamPath('project', 'instance'), { offset: '-1', limit: 1000 }))
    .batches.flatMap((batch) => batch.records);
  return { instance, restart, persist, seed, activity, schedules, replies, db, native, product, admit, idle, records, fibers };
}

test('generated native class inherits read-only cutover RPC with exact object identity', async () => {
  const f = fixture();
  const { sdkObservationFixture } = await import('../cutover/observation-test-fixtures');
  const sdk = sdkObservationFixture();
  for (const row of sdk.sql.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name LIKE 'cf_agent%'").all()) {
    f.native.exec(String(row.sql));
  }
  f.native.exec("INSERT INTO cf_agents_state(id,state) VALUES('cf_schema_version','11')");
  const before = f.native.prepare("SELECT total_changes() AS n").get()!.n;
  const result = await f.instance.observeCutover({ namespaceId: 'local-only', objectId: 'object-id' });
  assert.equal(result.generation, 'g2'); assert.equal(result.status, 'observed-idle');
  assert.equal(f.native.prepare("SELECT total_changes() AS n").get()!.n, before);
  await assert.rejects(f.instance.observeCutover({ namespaceId: 'local-only', objectId: 'wrong' }), /identity mismatch/);
  assert.deepEqual(f.schedules(), []); sdk.sql.close();
});

test('generated native class inherits reply RPC and arms durable settlement wakes around its fiber', async () => {
  const f = fixture(); await f.seed();
  await f.instance.runFiber('flue:submission-attempt', async () => {
    assert.deepEqual(f.schedules().map((row) => row.delay), [30]);
    await f.persist();
  });
  assert.deepEqual(f.schedules().map((row) => row.delay), [30, 0]);
  await f.instance.reconcileReplies();
  assert.equal(f.replies()[0]?.text, 'Native recovered answer');
  await f.instance.reconcileReplies();
  assert.equal(f.replies().length, 1);
});

test('fresh generated instance captures native SQLite settlement without a live observer or fiber finally', async () => {
  const f = fixture(); await f.seed(); await f.persist();
  const restarted = f.restart();
  await restarted.onStart();
  assert.deepEqual(f.schedules().map((row) => row.delay), [0]);
  await restarted.alarm();
  assert.equal(f.replies()[0]?.text, 'Native recovered answer');
});

test('pending capture retries through SDK schedules and unrelated fibers remain untouched', async () => {
  const f = fixture(); await f.seed();
  await f.instance.reconcileReplies();
  assert.deepEqual(f.schedules().map((row) => row.delay), [30]);
  assert.equal(await f.instance.runFiber('other-product-fiber', async () => 7), 7);
  assert.equal(f.schedules().length, 1);
});

test('native fiber rejection retains the original error and leaves durable reply wake', async () => {
  const f = fixture();
  const error = new Error('native failure');
  await assert.rejects(f.instance.runFiber('flue:submission-attempt', async () => { throw error; }), (actual) => actual === error);
  assert.deepEqual(f.schedules().map((row) => row.delay), [30, 0]);
});

test('real native dispatch and model generation immediately deliver and finalize once', async () => {
  const faux = fauxProvider();
  setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('Actual native answer')]);
  function Canary() { useModel('faux/faux-1'); return 'Answer the admitted question.'; }
  const f = fixture(Canary, { TOKEN: 'local-test-token' });
  await seedReplyTracker(f.db, { instanceId: 'instance', eventId: 'event', target, ackMessageTs: 'ack', publish: true });
  f.activity();
  await stageReply(f.db, { instanceId: 'another-instance', responseId: 'other', target, text: 'Another conversation answer' });
  const calls: Array<{ method: string; body: Record<string, any> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = new URL(String(url)).pathname.split('/').at(-1)!;
    assert.ok(['chat.postMessage', 'chat.update'].includes(method), `Unexpected network request: ${url}`);
    calls.push({ method, body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true, ts: 'posted' });
  };
  try {
    const receipt = await f.admit('event');
    const replay = await f.admit('event');
    assert.equal(replay.submissionId, receipt.submissionId);
    assert.equal(replay.deduplicated, true);
    assert.equal(f.native.prepare('SELECT COUNT(*) AS count FROM flue_agent_submissions').get()?.count, 1);
    await f.instance.__flueWakeAgentSubmissions();
    await f.idle();
    assert.equal(faux.state.callCount, 1);
    const records = await f.records();
    assert.ok(records.some((r) => r.id === `record_dispatch_input_${receipt.submissionId}` && r.type === 'signal'
      && r.attributes?.eventId === 'event'));
    assert.ok(records.some((r) => r.type === 'assistant_message_started' && r.submissionId === receipt.submissionId));
    assert.ok(records.some((r) => r.type === 'submission_settled' && r.submissionId === receipt.submissionId && r.outcome === 'completed'));
    assert.ok(f.schedules().some((row) => row.delay === 0 && row.callback === 'reconcileReplies'));
    // Dispatch the real generated alarm boundary, including any redundant native
    // drain rows ahead of the product fast wake. No cron or direct RPC is needed.
    for (let pass = 0; pass < 5 && calls.length === 0; pass++) await f.instance.alarm();
    assert.equal(calls.filter((call) => call.method === 'chat.postMessage').length, 1);
    await f.instance.reconcileReplies();
    await f.instance.reconcileReplies();
    assert.equal(calls.filter((call) => call.method === 'chat.postMessage').length, 1);
    assert.equal(calls[0].body.text, 'Actual native answer');
    assert.ok(calls[0].body.metadata.event_payload.delivery_id);
    assert.equal(f.product.prepare('SELECT COUNT(*) AS count FROM messages').get()?.count, 1);
    assert.equal(f.product.prepare('SELECT status FROM slack_reply_trackers').get()?.status, 'delivered');
    assert.equal(f.product.prepare('SELECT status FROM slack_turn_activity').get()?.status, 'completed');
    assert.deepEqual(calls.filter((call) => call.method === 'chat.update').map((call) => call.body.ts), ['ack']);
    assert.equal(f.product.prepare("SELECT status FROM slack_reply_outbox WHERE instance_id='another-instance'").get()?.status, 'pending');
  } finally { globalThis.fetch = original; }
});

test('actual native busy dispatch joins one host and preserves both no-tool finals', async () => {
  const faux = fauxProvider();
  setProvider(faux.provider);
  function Canary() { useModel('faux/faux-1'); return 'Answer each admitted question.'; }
  const f = fixture(Canary);
  await f.seed();
  await seedReplyTracker(f.db, { instanceId: 'instance', eventId: 'joined-event', target, publish: true });
  let joinedId: string | undefined;
  faux.setResponses([
    async () => {
      joinedId = (await f.admit('joined-event')).submissionId;
      return fauxAssistantMessage('First no-tool final');
    },
    fauxAssistantMessage('Second no-tool final'),
  ]);
  const host = await f.admit('event');
  await f.instance.__flueWakeAgentSubmissions();
  await f.idle();
  assert.equal(faux.state.callCount, 2);
  assert.ok(joinedId);
  const rows = f.native.prepare('SELECT submission_id,status,joined_into,attempt_id FROM flue_agent_submissions ORDER BY sequence').all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.status), ['settled', 'settled']);
  assert.equal(rows[1].joined_into, host.submissionId);
  const records = await f.records();
  const starts = records.filter((r) => r.type === 'assistant_message_started');
  assert.equal(starts.length, 2);
  assert.ok(starts.every((r) => r.submissionId === host.submissionId));
  const settlements = records.filter((r) => r.type === 'submission_settled');
  assert.deepEqual(new Set(settlements.map((r) => r.submissionId)), new Set([host.submissionId, joinedId]));
  assert.equal(new Set(settlements.map((r) => r.attemptId)).size, 1);
  await f.instance.reconcileReplies();
  await f.instance.reconcileReplies();
  assert.deepEqual(f.replies().map((row) => row.text), ['First no-tool final\n\nSecond no-tool final']);
  assert.equal(f.product.prepare('SELECT COUNT(DISTINCT response_id) AS count FROM slack_reply_trackers').get()?.count, 1);
});

test('native transient provider retry retains an earlier completed no-tool final', async () => {
  const faux = fauxProvider(); setProvider(faux.provider);
  function Canary() { useModel('faux/faux-1'); return 'Answer.'; }
  const f = fixture(Canary); await f.seed();
  await seedReplyTracker(f.db, { instanceId: 'instance', eventId: 'joined-event', target, publish: true });
  faux.setResponses([
    async () => { await f.admit('joined-event'); return fauxAssistantMessage('Completed before retry'); },
    fauxAssistantMessage('Do not publish failed text', { stopReason: 'error', errorMessage: '503 service unavailable' }),
    fauxAssistantMessage('Completed after native retry'),
  ]);
  const receipt = await f.admit('event');
  await f.instance.__flueWakeAgentSubmissions(); await f.idle();
  const records = await f.records();
  assert.equal(faux.state.callCount, 3);
  const settlement = records.find((r) => r.type === 'submission_settled' && r.submissionId === receipt.submissionId);
  assert.equal(settlement?.type === 'submission_settled' && settlement.outcome, 'completed');
  assert.equal(records.filter((r) => r.type === 'assistant_message_completed').length, 3);
  await f.instance.reconcileReplies();
  assert.deepEqual(f.replies().map((row) => row.text), ['Completed before retry\n\nCompleted after native retry']);
});

test('fresh isolate replays actual native settlement after all final wakes were lost', async () => {
  const faux = fauxProvider(); setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('Recovered actual generation')]);
  function Canary() { useModel('faux/faux-1'); return 'Answer.'; }
  const f = fixture(Canary); await f.seed();
  await f.admit('event'); await f.instance.__flueWakeAgentSubmissions(); await f.idle();
  f.native.exec('DELETE FROM test_schedules');
  const restarted = f.restart();
  await restarted.onStart();
  assert.deepEqual(f.schedules().map((row) => row.callback), ['reconcileReplies']);
  await restarted.alarm();
  assert.deepEqual(f.replies().map((row) => row.text), ['Recovered actual generation']);
  assert.equal(faux.state.callCount, 1);
});

for (const mode of ['empty', 'failed', 'aborted', 'silent'] as const) {
  test(`actual native ${mode} settlement repairs exact receipt without posting an answer`, async () => {
    const faux = fauxProvider(); setProvider(faux.provider);
    function Canary() { useModel('faux/faux-1'); return 'Answer.'; }
    const f = fixture(Canary, { TOKEN: 'local-test-token' });
    f.activity();
    await seedReplyTracker(f.db, { instanceId: 'instance', eventId: 'event', target, ackMessageTs: 'ack', publish: mode !== 'silent' });
    faux.setResponses([mode === 'failed'
      ? fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'scripted failure' })
      : fauxAssistantMessage(mode === 'silent' ? 'Private internal result' : '')]);
    const calls: Array<Record<string, any>> = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      assert.equal(new URL(String(url)).pathname, '/api/chat.update');
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    };
    try {
      const receipt = await f.admit('event');
      // Abort deliberately loses the D1 receipt attachment before execution: its
      // canonical history has no dispatch input signal to replay for eventId.
      if (mode !== 'aborted') await attachReplySubmission(f.db, { instanceId: 'instance', eventId: 'event', submissionId: receipt.submissionId });
      if (mode === 'aborted') {
        const response = await f.instance.onRequest(new Request('https://internal/agents/project/instance/abort', { method: 'POST' }));
        assert.equal((await response.json()).aborted, true);
      }
      await f.instance.__flueWakeAgentSubmissions(); await f.idle();
      const canonical = (await f.records()).find((r) => r.type === 'submission_settled' && r.submissionId === receipt.submissionId);
      assert.equal(canonical?.type === 'submission_settled' && canonical.outcome,
        mode === 'failed' || mode === 'aborted' ? mode : 'completed');
      await f.instance.reconcileReplies();
      assert.equal(f.replies().length, 0);
      assert.equal(f.product.prepare('SELECT status FROM slack_reply_trackers').get()?.status, mode);
      assert.equal(f.product.prepare('SELECT status FROM slack_turn_activity').get()?.status, mode === 'silent' ? 'completed' : 'failed');
      assert.deepEqual(calls.map((call) => call.ts), ['ack']);
      // The same terminal result must not alter a receipt owned by a later turn.
      f.product.exec("UPDATE slack_turn_activity SET ack_message_ts='new-ack',status='active'");
      await f.instance.reconcileReplies();
      assert.equal(calls.length, 1);
      assert.equal(f.product.prepare('SELECT status FROM slack_turn_activity').get()?.status, 'active');
    } finally { globalThis.fetch = original; }
  });
}

test('schedule failure cannot replace the original native fiber error', async () => {
  const f = fixture();
  f.instance.schedule = async () => { throw new Error('schedule unavailable'); };
  const error = new Error('original native failure');
  await assert.rejects(f.instance.runFiber('flue:submission-attempt', async () => { throw error; }), (actual) => actual === error);
});

await run();
