// Slack activity receipt invariants — run: npx tsx src/slack/activity.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';
import {
  completeSlackTurnActivity,
  createSlackTurnActivity,
  handleObservedSlackActivity,
  loadSlackTurnActivity,
  recordSlackStreamHeartbeat,
  recordSlackToolActivity,
  renderSlackActivityReceipt,
  STREAM_HEARTBEAT_MS,
  shouldPostFinalBelowActivity,
  toolActivityLabel,
  withSlackActivityLock,
  settleSlackTurnActivity,
} from './activity';

const { test, run } = createTestRunner();

type Row = Record<string, unknown>;

class FakeD1 implements D1Like {
  rows: Row[] = [];
  trackers: Row[] = [{ instance_id: 'project:P:agent:default/conv:slack:T:C:100.000', submission_id: 'native', ack_message_ts: '101.000' }];

  prepare(query: string) {
    const db = this;
    return {
      bind(...values: unknown[]) {
        return {
          async first<T = Row>(): Promise<T | null> {
            const { results } = await this.all<T>();
            return results[0] ?? null;
          },
          async all<T = Row>(): Promise<{ results: T[] }> {
            if (query.includes('FROM slack_reply_trackers')) {
              const [instanceId, submissionId] = values;
              return { results: db.trackers.filter((row) => row.instance_id === instanceId && row.submission_id === submissionId && row.ack_message_ts) as T[] };
            }
            if (query.includes('FROM slack_turn_activity')) {
              const [projectId, sessionId] = values;
              return {
                results: db.rows.filter((row) => row.project_id === projectId && row.session_id === sessionId) as T[],
              };
            }
            return { results: [] as T[] };
          },
          async run(): Promise<{ meta: { changes: number } }> {
            if (query.startsWith('INSERT INTO slack_turn_activity')) {
              const [
                projectId,
                sessionId,
                conversationId,
                slackChannelId,
                slackThreadTs,
                ackMessageTs,
                transportTokenRef,
                status,
                activitiesJson,
                lastPostedAt,
                createdAt,
                updatedAt,
                completedAt,
              ] = values;
              const existing = db.rows.find((row) => row.project_id === projectId && row.session_id === sessionId);
              if (existing) {
                Object.assign(existing, {
                  conversation_id: conversationId,
                  slack_channel_id: slackChannelId,
                  slack_thread_ts: slackThreadTs,
                  ack_message_ts: ackMessageTs,
                  transport_token_ref: transportTokenRef,
                  status,
                  activities_json: activitiesJson,
                  last_posted_at: lastPostedAt,
                  created_at: createdAt,
                  updated_at: updatedAt,
                  completed_at: completedAt,
                });
              } else {
                db.rows.push({
                  project_id: projectId,
                  session_id: sessionId,
                  conversation_id: conversationId,
                  slack_channel_id: slackChannelId,
                  slack_thread_ts: slackThreadTs,
                  ack_message_ts: ackMessageTs,
                  transport_token_ref: transportTokenRef,
                  status,
                  activities_json: activitiesJson,
                  last_posted_at: lastPostedAt,
                  created_at: createdAt,
                  updated_at: updatedAt,
                  completed_at: completedAt,
                });
              }
              return { meta: { changes: 1 } };
            }
            if (query.includes('SET updated_at=? WHERE') && query.includes("status='active' AND updated_at <=")) {
              // Stream heartbeat: throttled, no-rewind bump of updated_at only (atomic WHERE clause).
              const [now, projectId, sessionId, threshold, expectedAck] = values as [number, string, string, number, string | null];
              const row = db.rows.find(
                (item) =>
                  item.project_id === projectId &&
                  item.session_id === sessionId &&
                  item.status === 'active' &&
                  (item.updated_at as number) <= threshold && (!expectedAck || item.ack_message_ts === expectedAck),
              );
              if (!row) return { meta: { changes: 0 } };
              row.updated_at = now;
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('UPDATE slack_turn_activity')) {
              const [status, activitiesJson, lastPostedAt, updatedAt, completedAt, projectId, sessionId, expectedAck] = values;
              const row = db.rows.find((item) => item.project_id === projectId && item.session_id === sessionId);
              if (!row || row.status !== 'active' || row.ack_message_ts !== expectedAck) return { meta: { changes: 0 } };
              Object.assign(row, {
                status,
                activities_json: activitiesJson,
                last_posted_at: lastPostedAt,
                updated_at: updatedAt,
                completed_at: completedAt,
              });
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
        };
      },
    };
  }
}

function input(overrides: Partial<Parameters<typeof createSlackTurnActivity>[1]> = {}) {
  return {
    projectId: 'P',
    sessionId: 'conv:slack:T:C:100.000',
    conversationId: 'slack:T:C:100.000',
    slackChannelId: 'C',
    slackThreadTs: '100.000',
    ackMessageTs: '101.000',
    transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    now: 1000,
    ...overrides,
  };
}

function installFetchCapture(calls: Array<{ url: string; body: Record<string, unknown> }>) {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

test('creates and loads an active receipt by project and session', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input());

  const activity = await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000');

  assert.equal(activity?.status, 'active');
  assert.equal(activity?.conversationId, 'slack:T:C:100.000');
  assert.equal(activity?.ackMessageTs, '101.000');
  assert.deepEqual(activity?.activities, []);
});

test('a new turn in the same thread resets the receipt clock (created_at survives the upsert)', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 0 }));
  // 19 minutes later, a NEW turn starts in the same thread → same (project, session) row.
  const later = 19 * 60_000;
  await createSlackTurnActivity(db, input({ now: later, ackMessageTs: '102.000' }));
  const activity = await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000');
  assert.equal(activity?.createdAt, later, 'clock starts at the new turn, not the first turn in the thread');
  assert.match(renderSlackActivityReceipt(activity!, { now: later + 30_000 }), /<1 min/);
});

test('maps allowlisted tools to friendly labels and hides unknown tools', () => {
  assert.equal(toolActivityLabel('execute_code'), 'Running code');
  assert.equal(toolActivityLabel('github_call_api'), 'Reading GitHub');
  assert.equal(toolActivityLabel('linear_call_api'), 'Reading Linear');
  assert.equal(toolActivityLabel('notion_call_api'), 'Reading Notion');
  assert.equal(toolActivityLabel('search_channel'), 'Searching this channel');
  assert.equal(toolActivityLabel('save_memory'), 'Updating memory');
  assert.equal(toolActivityLabel('raw_internal_tool'), null);
});

test('records, dedupes, caps visible rows, and never renders args or results', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input());

  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'execute_code', now: 1100 });
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'execute_code', now: 1200 });
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'setup_status', now: 1300 });
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'request_connection', now: 1400 });
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'github_call_api', now: 1500 });
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'linear_call_api', now: 1600 });
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'notion_call_api', now: 1700 });
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'search_channel', now: 1800 });
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'unknown_tool', now: 1900 });

  const activity = await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000');
  assert.equal(activity?.activities.length, 7);
  const rendered = renderSlackActivityReceipt(activity!);

  assert.match(rendered, /Running code \(x2\)/);
  assert.match(rendered, /Checking setup/);
  assert.match(rendered, /\+1 more/);
  assert.doesNotMatch(rendered, /unknown_tool/);
  assert.doesNotMatch(rendered, /language/);
  assert.doesNotMatch(rendered, /result/);
});

test('marks failed activity without leaking the error text and terminal updates bypass throttle', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 1000 }));
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'execute_code', now: 1100 });

  const failed = await recordSlackToolActivity(db, {
    projectId: 'P',
    sessionId: 'conv:slack:T:C:100.000',
    toolName: 'execute_code',
    isError: true,
    now: 1101,
    terminal: true,
    error: 'secret stack trace',
  });

  assert.equal(failed?.shouldPost, true);
  const rendered = renderSlackActivityReceipt(failed!.activity);
  assert.match(rendered, /Running code/);
  assert.match(rendered, /failed/i);
  assert.doesNotMatch(rendered, /secret stack trace/);
});

test('throttles normal updates but not the first update', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 1000 }));

  const first = await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'execute_code', now: 1100 });
  const second = await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'setup_status', now: 1200 });
  const third = await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'request_connection', now: 3100 });

  assert.equal(first?.shouldPost, true);
  assert.equal(second?.shouldPost, false);
  assert.equal(third?.shouldPost, true);
});

test('renders active receipts with elapsed time and current phase', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 0 }));

  await recordSlackToolActivity(db, {
    projectId: 'P',
    sessionId: 'conv:slack:T:C:100.000',
    toolName: 'execute_code',
    now: 12 * 60 * 1000,
  });

  const activity = await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000');
  const rendered = renderSlackActivityReceipt(activity!, { now: 12 * 60 * 1000 });

  assert.match(rendered, /^⏳ Working — 12 min — running code/);
});

test('renders completed receipts with elapsed time frozen at completion', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 0 }));
  await recordSlackToolActivity(db, {
    projectId: 'P',
    sessionId: 'conv:slack:T:C:100.000',
    toolName: 'setup_status',
    now: 60 * 1000,
  });

  const completed = await completeSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000', 'completed', 2 * 60 * 1000);
  const rendered = renderSlackActivityReceipt(completed!, { now: 30 * 60 * 1000 });

  assert.match(rendered, /^✅ Activity — 2 min/);
  assert.doesNotMatch(rendered, /30 min/);
});

test('final replies post below only when the receipt has visible activity', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input());
  assert.equal(await shouldPostFinalBelowActivity(db, 'P', 'conv:slack:T:C:100.000'), false);

  await recordSlackToolActivity(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', toolName: 'execute_code', now: 1100 });

  assert.equal(await shouldPostFinalBelowActivity(db, 'P', 'conv:slack:T:C:100.000'), true);
});

test('Flue observer ignores non-Slack sessions and non-project agents', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input());
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const restore = installFetchCapture(calls);
  try {
    await handleObservedSlackActivity(
      { type: 'tool_start', instanceId: 'project:P:agent:default/heartbeat', session: 'default', toolName: 'execute_code', toolCallId: 'tc1' } as never,
      { env: { DB: db, SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' } } as never,
    );
    await handleObservedSlackActivity(
      { type: 'tool_start', instanceId: 'bad-instance', session: 'default', toolName: 'execute_code', toolCallId: 'tc1' } as never,
      { env: { DB: db, SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' } } as never,
    );
  } finally {
    restore();
  }

  assert.equal(calls.length, 0);
});

test('Flue observer edits the ack with friendly labels for known tool starts', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input());
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const restore = installFetchCapture(calls);
  try {
    await handleObservedSlackActivity(
      { type: 'tool_start', instanceId: 'project:P:agent:default/conv:slack:T:C:100.000', submissionId: 'native', session: 'default', toolName: 'execute_code', toolCallId: 'tc1' } as never,
      { env: { DB: db, SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' } } as never,
    );
  } finally {
    restore();
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://slack.com/api/chat.update');
  assert.equal(calls[0].body.channel, 'C');
  assert.equal(calls[0].body.ts, '101.000');
  assert.match(String(calls[0].body.text), /Running code/);
});

test('Flue observer shows stream-response phase only after visible work exists', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input());
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const restore = installFetchCapture(calls);
  try {
    await handleObservedSlackActivity(
      { type: 'message_start', instanceId: 'project:P:agent:default/conv:slack:T:C:100.000', submissionId: 'native', session: 'default', message: { role: 'assistant' } } as never,
      { env: { DB: db, SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' } } as never,
    );
    await handleObservedSlackActivity(
      { type: 'tool_start', instanceId: 'project:P:agent:default/conv:slack:T:C:100.000', submissionId: 'native', session: 'default', toolName: 'execute_code', toolCallId: 'tc1' } as never,
      { env: { DB: db, SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' } } as never,
    );
    await handleObservedSlackActivity(
      { type: 'message_start', instanceId: 'project:P:agent:default/conv:slack:T:C:100.000', submissionId: 'native', session: 'default', message: { role: 'assistant' } } as never,
      { env: { DB: db, SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' } } as never,
    );
  } finally {
    restore();
  }

  assert.equal(calls.length, 2);
  assert.doesNotMatch(String(calls[0].body.text), /Receiving stream response/);
  assert.match(String(calls[1].body.text), /Receiving stream response/);
  assert.match(String(calls[1].body.text), /^⏳ Working .* receiving stream response/m);
});

test('Flue observer hides unknown tools and never posts args or results', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input());
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const restore = installFetchCapture(calls);
  try {
    await handleObservedSlackActivity(
      {
        type: 'tool_start',
        instanceId: 'project:P:agent:default/conv:slack:T:C:100.000', submissionId: 'native',
        session: 'default',
        toolName: 'secret_debug_tool',
        toolCallId: 'tc1',
        args: { token: 'secret-token' },
      } as never,
      { env: { DB: db, SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' } } as never,
    );
    await handleObservedSlackActivity(
      {
        type: 'tool',
        instanceId: 'project:P:agent:default/conv:slack:T:C:100.000', submissionId: 'native',
        session: 'default',
        toolName: 'execute_code',
        toolCallId: 'tc2',
        isError: true,
        result: 'secret stack trace',
        durationMs: 42,
      } as never,
      { env: { DB: db, SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' } } as never,
    );
  } finally {
    restore();
  }

  assert.equal(calls.length, 1);
  assert.match(String(calls[0].body.text), /Running code/);
  assert.match(String(calls[0].body.text), /failed/i);
  assert.doesNotMatch(String(calls[0].body.text), /secret_debug_tool/);
  assert.doesNotMatch(String(calls[0].body.text), /secret-token/);
  assert.doesNotMatch(String(calls[0].body.text), /secret stack trace/);
});

// ── stream heartbeat (token-level proof of life) ──────────────────────────────

test('stream heartbeat: a delta past the throttle window refreshes the liveness clock', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 1000 }));
  const t = 1000 + STREAM_HEARTBEAT_MS + 1;
  await recordSlackStreamHeartbeat(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', now: t });
  const activity = await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000');
  assert.equal(activity?.updatedAt, t, 'a token delta bumps updated_at — the model is provably alive');
});

test('stream heartbeat: throttled to one write per window regardless of token rate', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 1000 }));
  // A burst of deltas inside the window — none may move the clock (or we hammer D1 per token).
  await recordSlackStreamHeartbeat(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', now: 1001 });
  await recordSlackStreamHeartbeat(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', now: 1500 });
  let activity = await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000');
  assert.equal(activity?.updatedAt, 1000, 'deltas within the throttle window do not write');
  // One delta a full window later does write.
  await recordSlackStreamHeartbeat(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', now: 1000 + STREAM_HEARTBEAT_MS });
  activity = await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000');
  assert.equal(activity?.updatedAt, 1000 + STREAM_HEARTBEAT_MS, 'a delta past the window refreshes the clock');
});

test('stream heartbeat: never revives a completed or failed turn', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input({ now: 1000 }));
  await completeSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000', 'completed', 2000);
  await recordSlackStreamHeartbeat(db, { projectId: 'P', sessionId: 'conv:slack:T:C:100.000', now: 2000 + STREAM_HEARTBEAT_MS + 1 });
  const activity = await loadSlackTurnActivity(db, 'P', 'conv:slack:T:C:100.000');
  assert.equal(activity?.status, 'completed');
  assert.equal(activity?.updatedAt, 2000, 'a stray late delta cannot bump a finished turn');
});

test('user message_start never claims the model is responding', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input());
  await recordSlackToolActivity(db, { projectId: 'P', sessionId: input().sessionId, toolName: 'execute_code' });
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const restore = installFetchCapture(calls);
  try {
    await handleObservedSlackActivity(
      { type: 'message_start', instanceId: 'project:P:agent:default/conv:slack:T:C:100.000', submissionId: 'native', message: { role: 'user' } } as never,
      { env: { DB: db, SLACK_BOT_TOKEN_DEFAULT: 'x' } } as never,
    );
  } finally {
    restore();
  }
  assert.equal(calls.length, 0);
});

test('activity lock drains an earlier receipt before a final answer and ignores later activity', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input());
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const receipt = withSlackActivityLock(db, 'P', input().sessionId, async () => {
    order.push('receipt-start');
    await gate;
    order.push('receipt-end');
  });
  const final = withSlackActivityLock(db, 'P', input().sessionId, async () => {
    await completeSlackTurnActivity(db, 'P', input().sessionId);
    order.push('final');
  });
  release();
  await Promise.all([receipt, final]);
  assert.deepEqual(order, ['receipt-start', 'receipt-end', 'final']);
  assert.equal(await recordSlackToolActivity(db, { projectId: 'P', sessionId: input().sessionId, toolName: 'execute_code' }), null);
});

test('old native settlement cannot clear or edit a newer receipt in the same conversation', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input());
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const restore = installFetchCapture(calls);
  try {
    await settleSlackTurnActivity(db, { SLACK_BOT_TOKEN_DEFAULT: 'x' }, {
      projectId: 'P', conversationId: input().conversationId, ackMessageTs: 'old-ack', outcome: 'failed',
    });
  } finally { restore(); }
  assert.equal((await loadSlackTurnActivity(db, 'P', input().sessionId))?.status, 'active');
  assert.equal(calls.length, 0);
});

test('native failure settles only its receipt with a visible safe terminal message', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input());
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const restore = installFetchCapture(calls);
  try {
    await settleSlackTurnActivity(db, { SLACK_BOT_TOKEN_DEFAULT: 'x' }, {
      projectId: 'P', conversationId: input().conversationId, ackMessageTs: input().ackMessageTs, outcome: 'failed',
    });
  } finally { restore(); }
  assert.equal((await loadSlackTurnActivity(db, 'P', input().sessionId))?.status, 'failed');
  assert.equal(calls.length, 1);
  assert.match(String(calls[0].body.text), /could not finish/);
});

test('delivered completion renders receipt chrome and retries an interrupted edit', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input());
  const args = { projectId: 'P', conversationId: input().conversationId, ackMessageTs: input().ackMessageTs, outcome: 'completed' as const };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('connection lost'); }) as typeof fetch;
  try {
    await assert.rejects(settleSlackTurnActivity(db, { SLACK_BOT_TOKEN_DEFAULT: 'x' }, args), /connection lost/);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal((await loadSlackTurnActivity(db, 'P', input().sessionId))?.status, 'completed');
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const restore = installFetchCapture(calls);
  try { await settleSlackTurnActivity(db, { SLACK_BOT_TOKEN_DEFAULT: 'x' }, args); } finally { restore(); }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.ts, input().ackMessageTs);
  assert.equal(String(calls[0].body.text), renderSlackActivityReceipt((await loadSlackTurnActivity(db, 'P', input().sessionId))!));
});

test('native progress is keyed to the submission receipt, not the current conversation alone', async () => {
  const db = new FakeD1();
  await createSlackTurnActivity(db, input());
  const instanceId = 'project:P:agent:default/conv:slack:T:C:100.000';
  db.trackers.push({ instance_id: instanceId, submission_id: 'old', ack_message_ts: 'old-ack' });
  db.trackers.push({ instance_id: instanceId, submission_id: 'current', ack_message_ts: input().ackMessageTs });
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const restore = installFetchCapture(calls);
  try {
    for (const submissionId of [undefined, 'old', 'missing', 'current']) await handleObservedSlackActivity(
      { type: 'tool_start', instanceId, submissionId, toolName: 'execute_code' } as never,
      { env: { DB: db, SLACK_BOT_TOKEN_DEFAULT: 'x' } } as never,
    );
  } finally { restore(); }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.ts, input().ackMessageTs);
});

await run();
