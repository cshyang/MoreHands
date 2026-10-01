// Tool-call audit log — run: npx tsx src/connections/audit.test.ts
// The log records the SHAPE of every outbound provider call (who/what/outcome/duration), never the
// payload: bodies carry user content, query strings carry search terms — both stay out. Load-bearing
// invariants: query-string stripping, the recorder never throwing into a turn, and every outcome
// class (success, HTTP error, fetch failure, policy block) landing a row — failures are the calls
// you most need to see.

import assert from 'node:assert/strict';
import { createTestRunner, invokeTool } from '../shared/test-utils';
import { recordToolCall, sanitizePath, toolCallRecorder, type ToolCallRecord } from './audit';
import { genericApiTool, PROVIDER_API_PROFILES } from '../providers/generic-api';
import { githubReadTools } from '../providers/github';
import { buildConnectionRuntime } from './runtime';
import type { D1Like } from '../skills/repository';
import type { Binding } from '../project/bindings';

const { test, run } = createTestRunner();

// In-memory D1 fake capturing every prepare+bind so tests can assert on the exact write.
class CaptureD1 implements D1Like {
  writes: { sql: string; binds: unknown[] }[] = [];
  failNext = false;
  prepare(sql: string) {
    return {
      bind: (...values: unknown[]) => ({
        run: async () => {
          if (this.failNext) throw new Error('d1 unavailable');
          this.writes.push({ sql, binds: values });
          return {};
        },
        all: async <T>() => ({ results: [] as T[] }),
        first: async <T>() => null as T | null,
      }),
    };
  }
}

const CALL: ToolCallRecord = {
  provider: 'github',
  method: 'GET',
  path: '/repos/o/r/issues',
  status: 'success',
  durationMs: 120,
};

test('sanitizePath strips the query string (search terms are user content)', () => {
  assert.equal(sanitizePath('/search/code?q=secret+plans'), '/search/code');
  assert.equal(sanitizePath('/repos/o/r/issues'), '/repos/o/r/issues');
});

test('recordToolCall writes one row: project, provider, method, query-stripped path, status, duration', async () => {
  const db = new CaptureD1();
  await recordToolCall(db, 'proj-1', { ...CALL, path: '/search/code?q=secret' });
  assert.equal(db.writes.length, 1);
  assert.match(db.writes[0].sql, /INSERT INTO tool_calls/);
  const binds = db.writes[0].binds;
  assert.ok(binds.includes('proj-1'), 'project id bound');
  assert.ok(binds.includes('github'), 'provider bound');
  assert.ok(binds.includes('GET'), 'method bound');
  assert.ok(binds.includes('/search/code'), 'path bound with query stripped');
  assert.ok(!binds.some((b) => String(b).includes('q=secret')), 'query string never reaches the row');
  assert.ok(binds.includes('success'), 'status bound');
  assert.ok(binds.includes(120), 'duration bound');
});

test('toolCallRecorder is fire-and-forget: a failing D1 write never throws into the turn', async () => {
  const db = new CaptureD1();
  db.failNext = true;
  const record = toolCallRecorder(db, 'proj-1');
  assert.doesNotThrow(() => record(CALL));
  await settle();
});

test('toolCallRecorder writes through to D1', async () => {
  const db = new CaptureD1();
  toolCallRecorder(db, 'proj-1')(CALL);
  await settle();
  assert.equal(db.writes.length, 1);
});

// ── genericApiTool emits one audit record per call, whatever the outcome ───────────────────────

function collectingRecorder(): { records: ToolCallRecord[]; record: (r: ToolCallRecord) => void } {
  const records: ToolCallRecord[] = [];
  return { records, record: (r) => records.push(r) };
}

function githubTool(record: (r: ToolCallRecord) => void) {
  return genericApiTool(PROVIDER_API_PROFILES.github, 'ghp_token', {}, record);
}

async function withFetch(impl: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('success: a 200 call records {provider, method, path, success, duration}', async () => {
  const { records, record } = collectingRecorder();
  const tool = githubTool(record);
  await withFetch(async () => new Response('{"ok":true}', { status: 200 }), async () => {
    await invokeTool(tool, { method: 'GET', path: '/repos/o/r/issues' });
  });
  assert.equal(records.length, 1);
  assert.deepEqual(
    { ...records[0], durationMs: undefined },
    { provider: 'github', method: 'GET', path: '/repos/o/r/issues', status: 'success', durationMs: undefined },
  );
  assert.ok(typeof records[0].durationMs === 'number' && records[0].durationMs >= 0);
});

test('http_error: a non-ok response records http_error AND still throws to the model', async () => {
  const { records, record } = collectingRecorder();
  const tool = githubTool(record);
  await withFetch(async () => new Response('{"message":"Not Found"}', { status: 404 }), async () => {
    await assert.rejects(() => invokeTool(tool, { method: 'GET', path: '/repos/o/r/nope' }), /404/);
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'http_error');
});

test('fetch_error: a network failure/timeout records fetch_error AND still throws', async () => {
  const { records, record } = collectingRecorder();
  const tool = githubTool(record);
  await withFetch(
    async () => {
      throw new Error('socket hang up');
    },
    async () => {
      await assert.rejects(() => invokeTool(tool, { method: 'GET', path: '/repos/o/r/issues' }), /failed/);
    },
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'fetch_error');
});

test('blocked: a method-policy refusal records blocked — injection probes leave a trace', async () => {
  const { records, record } = collectingRecorder();
  const tool = githubTool(record); // github profile is get-only
  await assert.rejects(() => invokeTool(tool, { method: 'DELETE', path: '/repos/o/r' }), /Only GET/);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'blocked');
  assert.equal(records[0].method, 'DELETE');
});

test('no recorder wired → calls behave exactly as before (audit is optional)', async () => {
  const tool = genericApiTool(PROVIDER_API_PROFILES.github, 'ghp_token', {});
  await withFetch(async () => new Response('{}', { status: 200 }), async () => {
    const out = await invokeTool(tool, { method: 'GET', path: '/repos/o/r' });
    assert.equal(out, '{}');
  });
});

// ── the typed GitHub read tools audit through the same funnel ──────────────────────────────────

test('github typed tools: a successful read records through ghGet', async () => {
  const { records, record } = collectingRecorder();
  const tools = githubReadTools('ghp_token', 'o/r', record);
  const getIssue = tools.find((t) => t.name === 'github_get_issue')!;
  await withFetch(async () => new Response('{"number":7,"title":"t"}', { status: 200 }), async () => {
    await invokeTool(getIssue, { number: 7 });
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].provider, 'github');
  assert.equal(records[0].method, 'GET');
  assert.equal(records[0].path, '/repos/o/r/issues/7');
  assert.equal(records[0].status, 'success');
});

test('github typed tools: an upstream 404 records http_error AND still throws', async () => {
  const { records, record } = collectingRecorder();
  const tools = githubReadTools('ghp_token', 'o/r', record);
  const getIssue = tools.find((t) => t.name === 'github_get_issue')!;
  await withFetch(async () => new Response('{"message":"Not Found"}', { status: 404 }), async () => {
    await assert.rejects(() => invokeTool(getIssue, { number: 999 }), /404/);
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'http_error');
});

// ── end-to-end wiring: buildConnectionRuntime gives every connection tool the project recorder ──

test('runtime wiring: a call through a runtime-built tool lands an audit row in D1', async () => {
  const db = new CaptureD1();
  const binding: Binding = {
    provider: 'slack',
    externalAccountId: 'T',
    externalSpaceId: 'C',
    transportBotId: 'U',
    projectId: 'proj-e2e',
    sandboxMode: 'virtual',
    transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    connections: [{ provider: 'github', tokenRef: 'GITHUB_PAT_DEMO', config: { repo: 'o/r', apiMode: 'generic' } }],
    status: 'active',
  };
  const runtime = await buildConnectionRuntime({
    db,
    binding,
    env: { GITHUB_PAT_DEMO: 'ghp_x' },
    projectId: 'proj-e2e',
    listIntegrationsImpl: async () => [],
  });
  const callApi = runtime.tools.find((t) => t.name === 'github_call_api')!;
  await withFetch(async () => new Response('{}', { status: 200 }), async () => {
    await invokeTool(callApi, { method: 'GET', path: '/repos/o/r/issues?state=open' });
  });
  await settle();
  const auditWrites = db.writes.filter((w) => w.sql.includes('tool_calls'));
  assert.equal(auditWrites.length, 1, 'one audit row per call');
  assert.ok(auditWrites[0].binds.includes('proj-e2e'), 'scoped to the project');
  assert.ok(auditWrites[0].binds.includes('/repos/o/r/issues'), 'query string stripped at the write');
});

// Let fire-and-forget promises drain before asserting.
function settle(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

await run();
