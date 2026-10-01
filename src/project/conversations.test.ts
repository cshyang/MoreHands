// Conversation target invariants: ingress stores a provider-native reply target, while the
// agent only receives MoreHands's stable conversationId and resolves the target at send time.

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import type { Binding } from './bindings';
import {
  loadConversationTarget,
  resolveTarget,
  sendFinalToConversationTarget,
  sendToConversationTarget,
  topLevelTargetFromBinding,
  upsertConversationTarget,
  type ConversationTarget,
} from './conversations';
import { normalizeSlackMessage } from '../shared/canonical';
import type { D1Like } from '../skills/repository';
import { createSlackTurnActivity, recordSlackToolActivity } from '../slack/activity';

interface TargetRow {
  project_id: string;
  agent_slug: string;
  conversation_id: string;
  provider: 'slack';
  external_account_id: string;
  external_space_id: string;
  external_conversation_id: string;
  transport_token_ref: string;
  created_at: number;
  updated_at: number;
}

class FakeD1 implements D1Like {
  rows: TargetRow[] = [];
  activities: Record<string, unknown>[] = [];

  prepare(query: string) {
    const db = this;
    return {
      bind(...v: unknown[]) {
        return {
          async run(): Promise<unknown> {
            return db.exec(query, v);
          },
          async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
            return { results: db.select(query, v) as T[] };
          },
          async first<T = Record<string, unknown>>(): Promise<T | null> {
            return (db.select(query, v)[0] ?? null) as T | null;
          },
        };
      },
    };
  }

  private select(q: string, v: unknown[]): Record<string, unknown>[] {
    if (q.includes('FROM conversation_targets')) {
      const [project_id, agent_slug, conversation_id] = v as [string, string, string];
      return this.rows
        .filter(
          (r) =>
            r.project_id === project_id &&
            r.agent_slug === agent_slug &&
            r.conversation_id === conversation_id,
        )
        .map((r) => ({
          project_id: r.project_id,
          agent_slug: r.agent_slug,
          conversation_id: r.conversation_id,
          provider: r.provider,
          external_account_id: r.external_account_id,
          external_space_id: r.external_space_id,
          external_conversation_id: r.external_conversation_id,
          transport_token_ref: r.transport_token_ref,
        }));
    }
    if (q.includes('FROM slack_turn_activity')) {
      const [project_id, session_id] = v as [string, string];
      return this.activities.filter((r) => r.project_id === project_id && r.session_id === session_id);
    }
    return [];
  }

  private exec(q: string, v: unknown[]): { meta: { changes: number } } {
    if (q.startsWith('INSERT INTO conversation_targets')) {
      const [
        project_id,
        agent_slug,
        conversation_id,
        provider,
        external_account_id,
        external_space_id,
        external_conversation_id,
        transport_token_ref,
        created_at,
        updated_at,
      ] = v as [string, string, string, 'slack', string, string, string, string, number, number];
      const existing = this.rows.find(
        (r) =>
          r.project_id === project_id &&
          r.agent_slug === agent_slug &&
          r.conversation_id === conversation_id,
      );
      if (existing) {
        existing.provider = provider;
        existing.external_account_id = external_account_id;
        existing.external_space_id = external_space_id;
        existing.external_conversation_id = external_conversation_id;
        existing.transport_token_ref = transport_token_ref;
        existing.updated_at = updated_at;
        return { meta: { changes: 1 } };
      }
      this.rows.push({
        project_id,
        agent_slug,
        conversation_id,
        provider,
        external_account_id,
        external_space_id,
        external_conversation_id,
        transport_token_ref,
        created_at,
        updated_at,
      });
      return { meta: { changes: 1 } };
    }
    if (q.startsWith('INSERT INTO slack_turn_activity')) {
      const [
        project_id,
        session_id,
        conversation_id,
        slack_channel_id,
        slack_thread_ts,
        ack_message_ts,
        transport_token_ref,
        status,
        activities_json,
        last_posted_at,
        created_at,
        updated_at,
        completed_at,
      ] = v;
      const existing = this.activities.find((r) => r.project_id === project_id && r.session_id === session_id);
      const next = {
        project_id,
        session_id,
        conversation_id,
        slack_channel_id,
        slack_thread_ts,
        ack_message_ts,
        transport_token_ref,
        status,
        activities_json,
        last_posted_at,
        created_at,
        updated_at,
        completed_at,
      };
      if (existing) Object.assign(existing, next);
      else this.activities.push(next);
      return { meta: { changes: 1 } };
    }
    if (q.startsWith('UPDATE slack_turn_activity SET status=')) {
      const [status, activities_json, last_posted_at, updated_at, completed_at, project_id, session_id, ack_message_ts] = v;
      const existing = this.activities.find((r) => r.project_id === project_id && r.session_id === session_id
        && r.status === 'active' && r.ack_message_ts === ack_message_ts);
      if (!existing) return { meta: { changes: 0 } };
      Object.assign(existing, { status, activities_json, last_posted_at, updated_at, completed_at });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
}

const binding: Binding = {
  provider: 'slack',
  externalAccountId: 'T1',
  externalSpaceId: 'C1',
  transportBotId: 'Ubot',
  projectId: 'demo',
  sandboxMode: 'virtual',
  transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
  status: 'active',
};

const { test, run } = createTestRunner();

test('Slack normalization separates stable conversation id from native thread id', async () => {
  const msg = normalizeSlackMessage(
    'Ev1',
    'T1',
    { channel: 'C1', ts: '111.222', thread_ts: '100.000', user: 'U1', text: '<@Ubot> hi' },
    binding,
  );

  assert.equal(msg.conversationId, 'slack:T1:C1:100.000');
  assert.equal(msg.externalConversationId, '100.000');
  assert.equal(msg.senderId, 'slack:T1:U1');
});

test('conversation targets upsert and resolve by project, agent, and conversation', async () => {
  const db = new FakeD1();
  await upsertConversationTarget(db, {
    projectId: 'demo',
    conversationId: 'slack:T1:C1:100.000',
    provider: 'slack',
    externalAccountId: 'T1',
    externalSpaceId: 'C1',
    externalConversationId: '100.000',
    transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
  });
  await upsertConversationTarget(db, {
    projectId: 'demo',
    conversationId: 'slack:T1:C1:100.000',
    provider: 'slack',
    externalAccountId: 'T1',
    externalSpaceId: 'C1',
    externalConversationId: '100.000',
    transportTokenRef: 'SLACK_BOT_TOKEN_ROTATED',
  });

  const target = await loadConversationTarget(db, 'demo', 'default', 'slack:T1:C1:100.000');
  assert.equal(target?.externalSpaceId, 'C1');
  assert.equal(target?.externalConversationId, '100.000');
  assert.equal(target?.transportTokenRef, 'SLACK_BOT_TOKEN_ROTATED');
  assert.equal(await loadConversationTarget(db, 'demo', 'other-agent', 'slack:T1:C1:100.000'), null);
});

test('Slack send uses the stored provider target, not model-supplied channel fields', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; token: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      token: headers.get('authorization'),
    });
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const target: ConversationTarget = {
      projectId: 'demo',
      agentSlug: 'default',
      conversationId: 'slack:T1:C1:100.000',
      provider: 'slack',
      externalAccountId: 'T1',
      externalSpaceId: 'C1',
      externalConversationId: '100.000',
      transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    };
    await sendToConversationTarget({ SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' }, target, 'hello');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage');
    assert.equal(calls[0].token, 'Bearer xoxb-test');
    assert.deepEqual(calls[0].body, { channel: 'C1', text: 'hello', thread_ts: '100.000' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Slack send edits the ack message in place (chat.update) when ackMessageTs is supplied', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; token: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      token: headers.get('authorization'),
    });
    return new Response(JSON.stringify({ ok: true, ts: '555.666' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const target: ConversationTarget = {
      projectId: 'demo',
      agentSlug: 'default',
      conversationId: 'slack:T1:C1:100.000',
      provider: 'slack',
      externalAccountId: 'T1',
      externalSpaceId: 'C1',
      externalConversationId: '100.000',
      transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    };
    await sendToConversationTarget({ SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' }, target, 'final answer', '555.666');

    // Edits the ack (chat.update on its ts), NOT a second chat.postMessage. No thread_ts on an edit.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://slack.com/api/chat.update');
    assert.equal(calls[0].token, 'Bearer xoxb-test');
    assert.deepEqual(calls[0].body, { channel: 'C1', ts: '555.666', text: 'final answer' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Slack send formats Markdown before posting', async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, ts: '555.666' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const target: ConversationTarget = {
      projectId: 'demo',
      agentSlug: 'default',
      conversationId: 'slack:T1:C1:100.000',
      provider: 'slack',
      externalAccountId: 'T1',
      externalSpaceId: 'C1',
      externalConversationId: '100.000',
      transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    };
    await sendToConversationTarget(
      { SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' },
      target,
      '# Result\n\n**Ready**: [PR](https://github.com/acme/repo/pull/1)',
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.text, '*Result*\n\n*Ready*: <https://github.com/acme/repo/pull/1|PR>');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Slack send chunks oversized replies and edits the ack for part 1', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, ts: `posted-${calls.length}` }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const target: ConversationTarget = {
      projectId: 'demo',
      agentSlug: 'default',
      conversationId: 'slack:T1:C1:100.000',
      provider: 'slack',
      externalAccountId: 'T1',
      externalSpaceId: 'C1',
      externalConversationId: '100.000',
      transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    };
    await sendToConversationTarget(
      { SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test', SLACK_REPLY_MAX_CHARS: 24 },
      target,
      'Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.',
      '555.666',
    );

    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, 'https://slack.com/api/chat.update');
    assert.equal(calls[0].body.ts, '555.666');
    assert.match(String(calls[0].body.text), /^Part 1\/3/);
    assert.equal(calls[1].url, 'https://slack.com/api/chat.postMessage');
    assert.equal(calls[1].body.thread_ts, '100.000');
    assert.match(String(calls[1].body.text), /^Part 2\/3/);
    assert.match(String(calls[2].body.text), /^Part 3\/3/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Slack final reply leaves an activity receipt and posts answer below when activity exists', async () => {
  const db = new FakeD1();
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, ts: `posted-${calls.length}` }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const target: ConversationTarget = {
      projectId: 'demo',
      agentSlug: 'default',
      conversationId: 'slack:T1:C1:100.000',
      provider: 'slack',
      externalAccountId: 'T1',
      externalSpaceId: 'C1',
      externalConversationId: '100.000',
      transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    };
    await createSlackTurnActivity(db, {
      projectId: 'demo',
      sessionId: 'conv:slack:T1:C1:100.000',
      conversationId: 'slack:T1:C1:100.000',
      slackChannelId: 'C1',
      slackThreadTs: '100.000',
      ackMessageTs: '555.666',
      transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    });
    await recordSlackToolActivity(db, {
      projectId: 'demo',
      sessionId: 'conv:slack:T1:C1:100.000',
      toolName: 'execute_code',
    });

    await sendFinalToConversationTarget(
      { SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' },
      target,
      'final answer',
      {
        db,
        projectId: 'demo',
        sessionId: 'conv:slack:T1:C1:100.000',
        ackMessageTs: '555.666',
      },
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://slack.com/api/chat.update');
    assert.equal(calls[0].body.ts, '555.666');
    assert.match(String(calls[0].body.text), /Activity/);
    assert.match(String(calls[0].body.text), /Running code/);
    assert.equal(calls[1].url, 'https://slack.com/api/chat.postMessage');
    assert.deepEqual(calls[1].body, { channel: 'C1', text: 'final answer', thread_ts: '100.000' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Slack final reply still edits the ack when no activity exists', async () => {
  const db = new FakeD1();
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, ts: 'posted' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const target: ConversationTarget = {
      projectId: 'demo',
      agentSlug: 'default',
      conversationId: 'slack:T1:C1:100.000',
      provider: 'slack',
      externalAccountId: 'T1',
      externalSpaceId: 'C1',
      externalConversationId: '100.000',
      transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    };

    await sendFinalToConversationTarget(
      { SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' },
      target,
      'final answer',
      {
        db,
        projectId: 'demo',
        sessionId: 'conv:slack:T1:C1:100.000',
        ackMessageTs: '555.666',
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://slack.com/api/chat.update');
    assert.deepEqual(calls[0].body, { channel: 'C1', ts: '555.666', text: 'final answer' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Slack final reply closes an empty activity receipt so late memory updates cannot overwrite it', async () => {
  const db = new FakeD1();
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, ts: 'posted' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const target: ConversationTarget = {
      projectId: 'demo',
      agentSlug: 'default',
      conversationId: 'slack:T1:C1:100.000',
      provider: 'slack',
      externalAccountId: 'T1',
      externalSpaceId: 'C1',
      externalConversationId: '100.000',
      transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    };
    await createSlackTurnActivity(db, {
      projectId: 'demo',
      sessionId: 'conv:slack:T1:C1:100.000',
      conversationId: 'slack:T1:C1:100.000',
      slackChannelId: 'C1',
      slackThreadTs: '100.000',
      ackMessageTs: '555.666',
      transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    });

    await sendFinalToConversationTarget(
      { SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' },
      target,
      'final answer',
      {
        db,
        projectId: 'demo',
        sessionId: 'conv:slack:T1:C1:100.000',
        ackMessageTs: '555.666',
      },
    );

    const lateActivity = await recordSlackToolActivity(db, {
      projectId: 'demo',
      sessionId: 'conv:slack:T1:C1:100.000',
      toolName: 'update_memory',
    });

    assert.equal(lateActivity, null);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { channel: 'C1', ts: '555.666', text: 'final answer' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('top-level project posts omit provider-native thread id', async () => {
  const target = topLevelTargetFromBinding(binding);
  assert.equal(target.conversationId, '');
  assert.equal(target.externalConversationId, null);
  assert.equal(target.externalSpaceId, 'C1');
});

test('resolveTarget: top-level for empty conversationId, stored target otherwise, null without db', async () => {
  const db = new FakeD1();
  await upsertConversationTarget(db, {
    projectId: 'demo',
    conversationId: 'slack:T1:C1:100.000',
    provider: 'slack',
    externalAccountId: 'T1',
    externalSpaceId: 'C1',
    externalConversationId: '100.000',
    transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
  });

  // No conversationId → top-level project target (new post / heartbeat).
  const top = await resolveTarget(db, binding, 'demo', 'default', '');
  assert.equal(top?.conversationId, '');
  assert.equal(top?.externalConversationId, null);

  // conversationId relayed → the stored per-conversation target (lands in-thread).
  const stored = await resolveTarget(db, binding, 'demo', 'default', 'slack:T1:C1:100.000');
  assert.equal(stored?.externalConversationId, '100.000');

  // conversationId given but no db → null (can't resolve a stored target).
  assert.equal(await resolveTarget(undefined, binding, 'demo', 'default', 'slack:T1:C1:100.000'), null);
});

await run();
