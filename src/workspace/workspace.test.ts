// Coordinator workspace sandbox-tool invariants — run: npx tsx src/workspace/workspace.test.ts

import assert from 'node:assert/strict';
import { createTestRunner, invokeTool } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';
import {
  hasWorkspaceCapability,
  listWorkspaceOps,
  workspaceExec,
  workspaceLimits,
  workspaceReadFile,
  workspaceTools,
  workspaceWriteFile,
  type SandboxLike,
} from './workspace';

const { test, run } = createTestRunner();

type Row = Record<string, unknown>;

class FakeD1 implements D1Like {
  rows: Row[] = [];

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
            if (query.includes('FROM coordinator_workspace_ops')) {
              const [projectId, limit] = values;
              return {
                results: db.rows
                  .filter((r) => r.project_id === projectId)
                  .sort((a, b) => Number(b.created_at) - Number(a.created_at))
                  .slice(0, Number(limit ?? 20)) as T[],
              };
            }
            return { results: [] as T[] };
          },
          async run(): Promise<{ meta: { changes: number } }> {
            if (query.startsWith('INSERT INTO coordinator_workspace_ops')) {
              const [id, projectId, conversationId, op, detailPreview, bytesIn, createdAt] = values;
              db.rows.push({
                id,
                project_id: projectId,
                conversation_id: conversationId,
                op,
                detail_preview: detailPreview,
                status: 'running',
                error: null,
                result_preview: null,
                exit_code: null,
                bytes_in: bytesIn,
                bytes_out: null,
                created_at: createdAt,
                completed_at: null,
              });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('UPDATE coordinator_workspace_ops')) {
              const [status, error, resultPreview, exitCode, bytesOut, completedAt, id] = values;
              const row = db.rows.find((r) => r.id === id);
              if (row) Object.assign(row, { status, error, result_preview: resultPreview, exit_code: exitCode, bytes_out: bytesOut, completed_at: completedAt });
              return { meta: { changes: row ? 1 : 0 } };
            }
            return { meta: { changes: 0 } };
          },
        };
      },
    };
  }
}

class FakeSandbox implements SandboxLike {
  execCalls: Array<{ command: string; options?: { timeout?: number; cwd?: string } }> = [];
  execResult = { success: true, exitCode: 0, stdout: 'ok', stderr: '' };
  execError: Error | null = null;
  /** Simulates a dead-container RPC: the exec promise never settles. */
  execHangs = false;
  files = new Map<string, string>();

  async exec(command: string, options?: { timeout?: number; cwd?: string }) {
    this.execCalls.push({ command, options });
    if (this.execHangs) return new Promise<never>(() => {});
    if (this.execError) throw this.execError;
    return this.execResult;
  }

  async writeFile(path: string, content: string) {
    this.files.set(path, content);
    return { success: true };
  }

  async readFile(path: string) {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`no such file: ${path}`);
    return { success: true, content };
  }
}

function deps(db: FakeD1, sandbox: FakeSandbox, env: Record<string, unknown> = {}) {
  return { db, sandbox: () => sandbox, projectId: 'proj-1', env };
}

test('workspaceTools: gated off without db or sandbox, three tools with both', () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  assert.equal(workspaceTools({ projectId: 'p' }).length, 0);
  assert.equal(workspaceTools({ db, projectId: 'p' }).length, 0);
  assert.equal(workspaceTools({ sandbox: () => sandbox, projectId: 'p' }).length, 0);
  const tools = workspaceTools({ db, sandbox: () => sandbox, projectId: 'p' });
  assert.deepEqual(
    tools.map((t) => t.name),
    ['workspace_exec', 'workspace_write_file', 'workspace_read_file'],
  );
  assert.equal(hasWorkspaceCapability({ db, sandbox: () => sandbox }), true);
});

test('workspaceTools: building tools does not boot the sandbox (lazy thunk)', () => {
  const db = new FakeD1();
  let booted = 0;
  const sandbox = () => {
    booted += 1;
    return new FakeSandbox();
  };
  workspaceTools({ db, sandbox, projectId: 'p' });
  assert.equal(booted, 0);
});

test('workspaceExec: completes, records audit row with exit code and bounded preview', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  sandbox.execResult = { success: true, exitCode: 0, stdout: 'hello', stderr: '' };
  const result = await workspaceExec(deps(db, sandbox), { command: 'echo hello', conversationId: 'conv-1' });

  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'hello');
  assert.equal(sandbox.execCalls[0]?.options?.cwd, '/workspace');

  const [audit] = await listWorkspaceOps(db, 'proj-1');
  assert.equal(audit.op, 'exec');
  assert.equal(audit.status, 'completed');
  assert.equal(audit.exitCode, 0);
  assert.equal(audit.conversationId, 'conv-1');
  assert.equal(audit.detailPreview, 'echo hello');
  assert.ok(audit.completedAt !== null);
});

test('workspaceExec: non-zero exit is a completed op with the exit code recorded', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  sandbox.execResult = { success: false, exitCode: 2, stdout: '', stderr: 'boom' };
  const result = await workspaceExec(deps(db, sandbox), { command: 'false' });

  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, 'boom');
  const [audit] = await listWorkspaceOps(db, 'proj-1');
  assert.equal(audit.status, 'completed');
  assert.equal(audit.exitCode, 2);
});

test('workspaceExec: sandbox throw records failed audit with bounded error', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  sandbox.execError = new Error('container start timeout');
  const result = await workspaceExec(deps(db, sandbox), { command: 'echo hi' });

  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'container start timeout');
  const [audit] = await listWorkspaceOps(db, 'proj-1');
  assert.equal(audit.status, 'failed');
  assert.equal(audit.error, 'container start timeout');
});

test('workspaceExec: hung container RPC fails at timeout + client grace instead of hanging the turn', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  sandbox.execHangs = true;
  const result = await workspaceExec(deps(db, sandbox, { WORKSPACE_EXEC_CLIENT_GRACE_MS: '10' }), {
    command: 'sleep forever',
    timeoutMs: 10,
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /workspace_exec timed out after 20ms \(wall clock\)/);
  const [audit] = await listWorkspaceOps(db, 'proj-1');
  assert.equal(audit.status, 'failed');
  assert.match(String(audit.error), /wall clock/);
});

test('workspaceExec: empty command fails without touching the sandbox', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  const result = await workspaceExec(deps(db, sandbox), { command: '   ' });
  assert.equal(result.status, 'failed');
  assert.equal(sandbox.execCalls.length, 0);
});

test('workspaceExec: timeout clamps to the hard cap and reaches the sandbox', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  await workspaceExec(deps(db, sandbox), { command: 'sleep 1', timeoutMs: 9_999_999 });
  assert.equal(sandbox.execCalls[0]?.options?.timeout, 300_000);

  await workspaceExec(deps(db, sandbox), { command: 'sleep 1' });
  assert.equal(sandbox.execCalls[1]?.options?.timeout, 60_000);
});

test('workspaceExec: stdout/stderr previews and returns are secret-redacted and truncated', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  sandbox.execResult = { success: true, exitCode: 0, stdout: 'token ghp_abc123secret done', stderr: '' };
  const result = await workspaceExec(deps(db, sandbox), { command: 'env' });
  assert.ok(result.stdout.includes('[redacted]'));
  assert.ok(!result.stdout.includes('ghp_abc123secret'));

  const [audit] = await listWorkspaceOps(db, 'proj-1');
  assert.ok(!String(audit.resultPreview).includes('ghp_abc123secret'));

  sandbox.execResult = { success: true, exitCode: 0, stdout: 'x'.repeat(50_000), stderr: '' };
  const big = await workspaceExec(deps(db, sandbox, { WORKSPACE_MAX_OUTPUT_BYTES: '100' }), { command: 'cat big' });
  assert.equal(big.stdout.length, 100);
  assert.equal(big.truncated, true);
});

test('workspaceWriteFile: writes, audits bytes; oversized content fails before the sandbox', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  const ok = await workspaceWriteFile(deps(db, sandbox), { path: '/workspace/a.txt', content: 'hello' });
  assert.equal(ok.status, 'completed');
  assert.equal(ok.bytes, 5);
  assert.equal(sandbox.files.get('/workspace/a.txt'), 'hello');

  const big = await workspaceWriteFile(deps(db, sandbox, { WORKSPACE_MAX_WRITE_BYTES: '3' }), { path: '/workspace/b.txt', content: 'too big' });
  assert.equal(big.status, 'failed');
  assert.ok(!sandbox.files.has('/workspace/b.txt'));

  const audits = await listWorkspaceOps(db, 'proj-1');
  assert.equal(audits.length, 2);
  assert.ok(audits.every((a) => a.op === 'write_file'));
});

test('workspaceReadFile: returns content, truncates to cap, reports full size', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  sandbox.files.set('/workspace/data.csv', 'abcdefghij');

  const full = await workspaceReadFile(deps(db, sandbox), { path: '/workspace/data.csv' });
  assert.equal(full.status, 'completed');
  assert.equal(full.content, 'abcdefghij');
  assert.equal(full.truncated, false);

  const capped = await workspaceReadFile(deps(db, sandbox), { path: '/workspace/data.csv', maxBytes: 4 });
  assert.equal(capped.content, 'abcd');
  assert.equal(capped.truncated, true);
  assert.equal(capped.bytes, 10);

  const missing = await workspaceReadFile(deps(db, sandbox), { path: '/workspace/nope.csv' });
  assert.equal(missing.status, 'failed');
  assert.ok(String(missing.error).includes('no such file'));
});

test('workspaceLimits: env overrides apply, junk falls back to defaults', () => {
  const limits = workspaceLimits({ WORKSPACE_EXEC_TIMEOUT_MS: '1000', WORKSPACE_MAX_READ_BYTES: 'garbage' });
  assert.equal(limits.execTimeoutMs, 1000);
  assert.equal(limits.maxReadBytes, 1_000_000);
  assert.equal(limits.maxExecTimeoutMs, 300_000);
});

test('listWorkspaceOps: project-scoped, newest first', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  let t = 0;
  const timed = { ...deps(db, sandbox), now: () => (t += 10) };
  await workspaceExec(timed, { command: 'first' });
  await workspaceExec(timed, { command: 'second' });
  await workspaceExec({ ...timed, projectId: 'other' }, { command: 'elsewhere' });

  const audits = await listWorkspaceOps(db, 'proj-1');
  assert.equal(audits.length, 2);
  assert.equal(audits[0].detailPreview, 'second');
  assert.equal(audits[1].detailPreview, 'first');
});

test('workspace_exec tool: end-to-end through defineTool run returns JSON', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  sandbox.execResult = { success: true, exitCode: 0, stdout: 'tool ok', stderr: '' };
  const tools = workspaceTools({ db, sandbox: () => sandbox, projectId: 'proj-1' });
  const exec = tools.find((tool) => tool.name === 'workspace_exec')!;
  const raw = await invokeTool(exec, { command: 'echo tool ok' }, new AbortController().signal);
  const parsed = JSON.parse(String(raw));
  assert.equal(parsed.status, 'completed');
  assert.equal(parsed.stdout, 'tool ok');
});

await run();
