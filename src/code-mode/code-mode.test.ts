// Coordinator Dynamic Workers code-mode invariants — run: npx tsx src/code-mode/code-mode.test.ts

import assert from 'node:assert/strict';
import { createTestRunner, invokeTool } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';
import {
  buildDynamicWorkerCode,
  buildDynamicWorkerId,
  buildWorkerCodeSpec,
  codeModeTools,
  executeCode,
  listCodeExecutionAudits,
} from './code-mode';

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
            if (query.includes('FROM coordinator_code_executions')) {
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
            if (query.startsWith('INSERT INTO coordinator_code_executions')) {
              const [
                id,
                projectId,
                conversationId,
                language,
                purpose,
                codeHash,
                codePreview,
                networkMode,
                status,
                error,
                resultPreview,
                codeBytes,
                inputBytes,
                outputBytes,
                cpuMs,
                subrequests,
                createdAt,
                completedAt,
              ] = values;
              db.rows.push({
                id,
                project_id: projectId,
                conversation_id: conversationId,
                language,
                purpose,
                code_hash: codeHash,
                code_preview: codePreview,
                network_mode: networkMode,
                status,
                error,
                result_preview: resultPreview,
                code_bytes: codeBytes,
                input_bytes: inputBytes,
                output_bytes: outputBytes,
                cpu_ms: cpuMs,
                subrequests,
                created_at: createdAt,
                completed_at: completedAt,
              });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('UPDATE coordinator_code_executions')) {
              const [status, error, resultPreview, outputBytes, completedAt, id] = values;
              const row = db.rows.find((r) => r.id === id);
              if (!row) return { meta: { changes: 0 } };
              Object.assign(row, {
                status,
                error,
                result_preview: resultPreview,
                output_bytes: outputBytes,
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

class FakeEntrypoint {
  constructor(private readonly mode: 'success' | 'failure' | 'hang') {}

  async run(input: unknown): Promise<unknown> {
    if (this.mode === 'hang') return new Promise(() => {});
    if (this.mode === 'failure') throw new Error('dynamic failed');
    return { ok: true, input };
  }
}

class FakeWorkerStub {
  constructor(private readonly mode: 'success' | 'failure' | 'hang') {}

  getEntrypoint(name?: string | null, opts?: unknown) {
    return { name, opts, run: (input: unknown) => new FakeEntrypoint(this.mode).run(input) };
  }
}

class FakeLoader {
  calls: { id: string; spec: Record<string, unknown> }[] = [];

  constructor(private readonly mode: 'success' | 'failure' | 'hang' = 'success') {}

  get(id: string, callback: () => Record<string, unknown> | unknown) {
    const spec = callback();
    this.calls.push({ id, spec: spec as Record<string, unknown> });
    return new FakeWorkerStub(this.mode);
  }
}

test('buildDynamicWorkerCode wraps JavaScript and Python entrypoints', () => {
  const js = buildDynamicWorkerCode('javascript', 'export default async function main(input) { return input.x + 1; }');
  assert.match(js.mainModuleSource, /class CodeRunner extends WorkerEntrypoint/);
  assert.match(js.mainModuleSource, /await userMain\(input\)/);
  assert.deepEqual(js.compatibilityFlags, []);

  const py = buildDynamicWorkerCode('python', 'async def main(input):\n    return input["x"] + 1');
  assert.match(py.mainModuleSource, /class CodeRunner\(WorkerEntrypoint\):/);
  assert.match(py.mainModuleSource, /return await main\(input\)/);
  assert.deepEqual(py.compatibilityFlags, ['python_workers']);
});

test('buildWorkerCodeSpec defaults to public network and disables egress for network off', async () => {
  const open = await buildWorkerCodeSpec({
    language: 'javascript',
    code: 'export default async function main() { return 1; }',
    network: 'open_public',
    limits: { cpuMs: 5000, subRequests: 50 },
  });
  assert.equal('globalOutbound' in open.spec, false);
  assert.deepEqual(open.spec.limits, { cpuMs: 5000, subRequests: 50 });

  const closed = await buildWorkerCodeSpec({
    language: 'javascript',
    code: 'export default async function main() { return 1; }',
    network: 'off',
    limits: { cpuMs: 5000, subRequests: 50 },
  });
  assert.equal(closed.spec.globalOutbound, null);
});

test('buildDynamicWorkerId is stable for equivalent code and changes by language/network', async () => {
  const code = 'export default async function main() { return 1; }';
  assert.equal(
    await buildDynamicWorkerId({ language: 'javascript', code, network: 'open_public' }),
    await buildDynamicWorkerId({ language: 'javascript', code, network: 'open_public' }),
  );
  assert.notEqual(
    await buildDynamicWorkerId({ language: 'javascript', code, network: 'open_public' }),
    await buildDynamicWorkerId({ language: 'javascript', code, network: 'off' }),
  );
});

test('executeCode runs through the loader and writes completed audit rows', async () => {
  const db = new FakeD1();
  const loader = new FakeLoader();
  const result = await executeCode({
    db,
    loader,
    projectId: 'P',
    now: () => 1000,
    id: () => 'exec_1',
    params: {
      language: 'javascript',
      code: 'export default async function main(input) { return input; }',
      input: { x: 1 },
      purpose: 'shape small json',
      conversationId: 'conv_1',
    },
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.result, { ok: true, input: { x: 1 } });
  assert.equal(result.network, 'open_public');
  assert.equal(loader.calls.length, 1);
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].status, 'completed');
  assert.equal(db.rows[0].project_id, 'P');
  assert.equal(db.rows[0].conversation_id, 'conv_1');
  assert.equal(String(db.rows[0].code_preview).includes('export default'), true);
});

test('executeCode records failed audit rows and returns structured errors', async () => {
  const db = new FakeD1();
  const result = await executeCode({
    db,
    loader: new FakeLoader('failure'),
    projectId: 'P',
    now: () => 1000,
    id: () => 'exec_fail',
    params: {
      language: 'javascript',
      code: 'export default async function main() { throw new Error("x"); }',
      purpose: 'show failure',
    },
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /dynamic failed/);
  assert.equal(db.rows[0].status, 'failed');
  assert.match(String(db.rows[0].error), /dynamic failed/);
});

test('executeCode fails a hung loader RPC at the wall-clock bound instead of hanging the turn', async () => {
  const db = new FakeD1();
  const result = await executeCode({
    db,
    loader: new FakeLoader('hang'),
    projectId: 'P',
    now: () => 1000,
    id: () => 'exec_hang',
    env: { CODE_EXEC_WALL_CLOCK_MS: '20' },
    params: {
      language: 'javascript',
      code: 'export default async function main() { return 1; }',
      purpose: 'hang forever',
    },
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /execute_code timed out after 20ms \(wall clock\)/);
  assert.equal(db.rows[0].status, 'failed');
  assert.match(String(db.rows[0].error), /wall clock/);
});

test('executeCode rejects over-limit code before invoking loader and still audits the failure', async () => {
  const db = new FakeD1();
  const loader = new FakeLoader();
  const result = await executeCode({
    db,
    loader,
    projectId: 'P',
    now: () => 1000,
    id: () => 'exec_limit',
    env: { CODE_EXEC_MAX_CODE_BYTES: '5' },
    params: {
      language: 'javascript',
      code: 'export default async function main() { return 1; }',
      purpose: 'too large',
    },
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /code is too large/);
  assert.equal(loader.calls.length, 0);
  assert.equal(db.rows[0].status, 'failed');
});

test('executeCode truncates oversized output returned to the model', async () => {
  const db = new FakeD1();
  const result = await executeCode({
    db,
    loader: new FakeLoader(),
    projectId: 'P',
    now: () => 1000,
    id: () => 'exec_truncate',
    env: { CODE_EXEC_MAX_OUTPUT_BYTES: '10' },
    params: {
      language: 'javascript',
      code: 'export default async function main() { return 1; }',
      input: { long: 'abcdefghijklmnopqrstuvwxyz' },
      purpose: 'truncate',
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.truncated, true);
  assert.equal(typeof result.result, 'string');
  assert.ok(String(result.result).length <= 20);
  assert.equal(db.rows[0].status, 'completed');
});

test('codeModeTools is exposed only when both DB and loader exist', () => {
  assert.deepEqual(codeModeTools({ db: undefined, loader: new FakeLoader(), projectId: 'P' }).map((t) => t.name), []);
  assert.deepEqual(codeModeTools({ db: new FakeD1(), loader: undefined, projectId: 'P' }).map((t) => t.name), []);
  assert.deepEqual(codeModeTools({ db: new FakeD1(), loader: new FakeLoader(), projectId: 'P' }).map((t) => t.name), ['execute_code']);
});

test('execute_code tool returns JSON and never includes Worker secrets from env', async () => {
  const [tool] = codeModeTools({
    db: new FakeD1(),
    loader: new FakeLoader(),
    projectId: 'P',
    env: { NANGO_SECRET_KEY: 'nk_secret', SLACK_BOT_TOKEN_DEFAULT: 'xoxb-secret' },
  });
  const output = await invokeTool(tool, {
    language: 'javascript',
    code: 'export default async function main() { return "ok"; }',
    purpose: 'safe',
  });

  assert.equal(output.includes('nk_secret'), false);
  assert.equal(output.includes('xoxb-secret'), false);
  assert.equal(JSON.parse(output).status, 'completed');
});

test('execute_code input validates enums, preserves optional JSON input, and requires purpose', async () => {
  const db = new FakeD1();
  const loader = new FakeLoader();
  const [tool] = codeModeTools({ db, loader, projectId: 'P' });
  const params = { language: 'javascript', code: 'export default async function main() { return "ok"; }', purpose: 'validation' };

  await assert.rejects(invokeTool(tool, { ...params, language: 'ruby' }));
  await assert.rejects(invokeTool(tool, { ...params, network: 'private' }));
  await assert.rejects(invokeTool(tool, { language: params.language, code: params.code }));
  assert.equal(db.rows.length, 0, 'invalid inputs do not reach the execution audit or loader');

  const output = JSON.parse(await invokeTool(tool, { ...params, input: { rows: [1, null, true] } }));
  assert.equal(output.status, 'completed');
  assert.equal(output.network, 'open_public', 'omitting network preserves the operation default');
});

test('listCodeExecutionAudits returns recent capped rows for one project', async () => {
  const db = new FakeD1();
  db.rows.push(
    { id: 'a', project_id: 'P', created_at: 1, code_preview: 'a' },
    { id: 'b', project_id: 'OTHER', created_at: 2, code_preview: 'b' },
    { id: 'c', project_id: 'P', created_at: 3, code_preview: 'c' },
  );

  const rows = await listCodeExecutionAudits(db, 'P', 1);
  assert.deepEqual(rows.map((r) => r.id), ['c']);
});

await run();
