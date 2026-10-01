import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { D1Like } from '../skills/repository';
import { byteLength as bytes, redactSecrets, safeJson, truncateToBytes } from '../shared/bounded';
import { withWallClock } from '../shared/wall-clock';

export type CodeLanguage = 'javascript' | 'python';
export type CodeNetworkMode = 'open_public' | 'off';
export type CodeExecutionStatus = 'running' | 'completed' | 'failed';

export interface CodeModeLimits {
  maxCodeBytes: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  cpuMs: number;
  subRequests: number;
  wallClockMs: number;
}

export interface DynamicWorkerLoaderLike {
  get(id: string, callback: () => DynamicWorkerCodeSpec | Promise<DynamicWorkerCodeSpec>): DynamicWorkerStubLike;
}

interface DynamicWorkerStubLike {
  getEntrypoint(name?: string | null, opts?: unknown): { run(input: unknown): Promise<unknown> };
}

export interface DynamicWorkerCodeSpec {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string>;
  limits: { cpuMs: number; subRequests: number };
  globalOutbound?: null;
}

export interface BuiltDynamicWorkerCode {
  mainModule: string;
  mainModuleSource: string;
  modules: Record<string, string>;
  compatibilityFlags: string[];
}

export interface CodeExecutionParams {
  language: CodeLanguage | string;
  code: string;
  input?: unknown;
  purpose: string;
  conversationId?: string;
  network?: CodeNetworkMode | string;
}

export interface CodeExecutionResult {
  executionId: string;
  status: 'completed' | 'failed';
  language: CodeLanguage;
  network: CodeNetworkMode;
  result: unknown;
  error: string | null;
  durationMs: number;
  truncated: boolean;
  limits: CodeModeLimits;
}

export interface CodeExecutionAuditRow {
  id: string;
  projectId: string;
  conversationId: string | null;
  language: string;
  purpose: string;
  codeHash: string;
  codePreview: string;
  networkMode: string;
  status: string;
  error: string | null;
  resultPreview: string | null;
  codeBytes: number;
  inputBytes: number;
  outputBytes: number | null;
  cpuMs: number;
  subRequests: number;
  createdAt: number;
  completedAt: number | null;
}

const DEFAULT_LIMITS: CodeModeLimits = {
  maxCodeBytes: 20_000,
  maxInputBytes: 100_000,
  maxOutputBytes: 20_000,
  cpuMs: 5000,
  subRequests: 50,
  wallClockMs: 60_000,
};

const COMPATIBILITY_DATE = '2026-06-09';
const PREVIEW_BYTES = 2000;

export function codeModeLimits(env: Record<string, unknown> = {}): CodeModeLimits {
  return {
    maxCodeBytes: positiveInt(env.CODE_EXEC_MAX_CODE_BYTES, DEFAULT_LIMITS.maxCodeBytes),
    maxInputBytes: positiveInt(env.CODE_EXEC_MAX_INPUT_BYTES, DEFAULT_LIMITS.maxInputBytes),
    maxOutputBytes: positiveInt(env.CODE_EXEC_MAX_OUTPUT_BYTES, DEFAULT_LIMITS.maxOutputBytes),
    cpuMs: positiveInt(env.CODE_EXEC_CPU_MS, DEFAULT_LIMITS.cpuMs),
    subRequests: positiveInt(env.CODE_EXEC_SUBREQUESTS, DEFAULT_LIMITS.subRequests),
    wallClockMs: positiveInt(env.CODE_EXEC_WALL_CLOCK_MS, DEFAULT_LIMITS.wallClockMs),
  };
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function hasCodeModeCapability(args: { db?: D1Like; loader?: DynamicWorkerLoaderLike }): boolean {
  return !!args.db && !!args.loader;
}

export function buildDynamicWorkerCode(language: CodeLanguage, code: string): BuiltDynamicWorkerCode {
  if (language === 'javascript') {
    const mainModule = 'runner.js';
    return {
      mainModule,
      compatibilityFlags: [],
      mainModuleSource:
        'import { WorkerEntrypoint } from "cloudflare:workers";\n' +
        'import userMain from "./user-code.js";\n\n' +
        'export class CodeRunner extends WorkerEntrypoint {\n' +
        '  async run(input) {\n' +
        '    return await userMain(input);\n' +
        '  }\n' +
        '}\n',
      modules: {
        [mainModule]:
          'import { WorkerEntrypoint } from "cloudflare:workers";\n' +
          'import userMain from "./user-code.js";\n\n' +
          'export class CodeRunner extends WorkerEntrypoint {\n' +
          '  async run(input) {\n' +
          '    return await userMain(input);\n' +
          '  }\n' +
          '}\n',
        'user-code.js': code,
      },
    };
  }

  const mainModule = 'runner.py';
  const mainModuleSource =
    'from workers import WorkerEntrypoint\n\n' +
    code.trimEnd() +
    '\n\n' +
    'class CodeRunner(WorkerEntrypoint):\n' +
    '    async def run(self, input):\n' +
    '        return await main(input)\n';
  return {
    mainModule,
    compatibilityFlags: ['python_workers'],
    mainModuleSource,
    modules: { [mainModule]: mainModuleSource },
  };
}

export async function buildDynamicWorkerId(args: {
  language: CodeLanguage;
  code: string;
  network: CodeNetworkMode;
}): Promise<string> {
  const codeHash = await hashText(`${args.language}:${args.network}:${args.code}`);
  return `morehands-code:${args.language}:${args.network}:${codeHash.slice(0, 32)}`;
}

export async function buildWorkerCodeSpec(args: {
  language: CodeLanguage;
  code: string;
  network: CodeNetworkMode;
  limits: Pick<CodeModeLimits, 'cpuMs' | 'subRequests'>;
}): Promise<{ id: string; codeHash: string; spec: DynamicWorkerCodeSpec }> {
  const codeHash = await hashText(args.code);
  const built = buildDynamicWorkerCode(args.language, args.code);
  const spec: DynamicWorkerCodeSpec = {
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: built.compatibilityFlags,
    mainModule: built.mainModule,
    modules: built.modules,
    limits: { cpuMs: args.limits.cpuMs, subRequests: args.limits.subRequests },
  };
  if (args.network === 'off') spec.globalOutbound = null;
  return {
    id: await buildDynamicWorkerId(args),
    codeHash,
    spec,
  };
}

export async function executeCode(args: {
  db: D1Like;
  loader: DynamicWorkerLoaderLike;
  projectId: string;
  params: CodeExecutionParams;
  env?: Record<string, unknown>;
  now?: () => number;
  id?: () => string;
}): Promise<CodeExecutionResult> {
  const now = args.now ?? Date.now;
  const id = args.id ?? (() => `code_${cryptoRandomId()}`);
  const started = now();
  const limits = codeModeLimits(args.env);
  const executionId = id();
  const language = normalizeLanguage(args.params.language);
  const network = normalizeNetwork(args.params.network);
  const input = args.params.input ?? null;
  const inputJson = safeJson(input);
  const codeBytes = bytes(args.params.code);
  const inputBytes = bytes(inputJson);
  const codeHash = await hashText(args.params.code);

  await insertAudit(args.db, {
    id: executionId,
    projectId: args.projectId,
    conversationId: normalizeOptionalText(args.params.conversationId),
    language,
    purpose: normalizePurpose(args.params.purpose),
    codeHash,
    codePreview: preview(args.params.code),
    networkMode: network,
    status: 'running',
    error: null,
    resultPreview: null,
    codeBytes,
    inputBytes,
    outputBytes: null,
    cpuMs: limits.cpuMs,
    subRequests: limits.subRequests,
    createdAt: started,
    completedAt: null,
  });

  const fail = async (message: string): Promise<CodeExecutionResult> => {
    const completedAt = now();
    await updateAudit(args.db, executionId, {
      status: 'failed',
      error: preview(message),
      resultPreview: null,
      outputBytes: 0,
      completedAt,
    });
    return {
      executionId,
      status: 'failed',
      language,
      network,
      result: null,
      error: message,
      durationMs: Math.max(0, completedAt - started),
      truncated: false,
      limits,
    };
  };

  if (codeBytes > limits.maxCodeBytes) return fail(`code is too large (${codeBytes} bytes > ${limits.maxCodeBytes} bytes)`);
  if (inputBytes > limits.maxInputBytes) return fail(`input is too large (${inputBytes} bytes > ${limits.maxInputBytes} bytes)`);

  try {
    const { id: workerId, spec } = await buildWorkerCodeSpec({
      language,
      code: args.params.code,
      network,
      limits,
    });
    const worker = args.loader.get(workerId, async () => spec);
    const entrypoint = worker.getEntrypoint('CodeRunner', { limits: { cpuMs: limits.cpuMs, subRequests: limits.subRequests } });
    // cpuMs bounds CPU inside the dynamic worker; it does nothing if the loader
    // RPC itself wedges (worker replaced by a deploy mid-call). Wall-clock race
    // turns that hang into a failed execution the model can retry.
    const rawResult = await withWallClock(entrypoint.run(input), limits.wallClockMs, 'execute_code');
    const outputJson = safeJson(rawResult);
    const outputBytes = bytes(outputJson);
    const truncated = outputBytes > limits.maxOutputBytes;
    const result = truncated ? truncateToBytes(outputJson, limits.maxOutputBytes) : rawResult;
    const completedAt = now();
    await updateAudit(args.db, executionId, {
      status: 'completed',
      error: null,
      resultPreview: preview(outputJson),
      outputBytes,
      completedAt,
    });
    return {
      executionId,
      status: 'completed',
      language,
      network,
      result,
      error: null,
      durationMs: Math.max(0, completedAt - started),
      truncated,
      limits,
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export function codeModeTools(args: {
  db?: D1Like;
  loader?: DynamicWorkerLoaderLike;
  projectId: string;
  env?: Record<string, unknown>;
}): ToolDefinition[] {
  if (!hasCodeModeCapability(args)) return [];
  const db = args.db!;
  const loader = args.loader!;
  return [
    defineTool({
      name: 'execute_code',
      description:
        'Run lightweight JavaScript or Python in a Cloudflare Dynamic Worker for computation, parsing, public web fetches, and repeatable transformations. This is not bash, not a repo workspace, not npm/pip install, and not source-code editing.',
      input: v.object({
        language: v.pipe(v.union([v.literal('javascript'), v.literal('python')]), v.description('javascript or python.')),
        code: v.pipe(
          v.string(),
          v.description('For JavaScript, export default async function main(input) { ... }. For Python, define async def main(input): ...'),
        ),
        input: v.optional(v.pipe(v.any(), v.description('Optional JSON input passed to main(input).'))),
        purpose: v.pipe(v.string(), v.description('Short reason for audit, e.g. parse API response or calculate totals.')),
        conversationId: v.optional(v.pipe(v.string(), v.description('Copy from the current Dispatch Input when available.'))),
        network: v.optional(v.pipe(v.union([v.literal('open_public'), v.literal('off')]), v.description('open_public (default) or off.'))),
      }),
      async run({ data: params }) {
        const result = await executeCode({
          db,
          loader,
          projectId: args.projectId,
          env: args.env,
          params: params as CodeExecutionParams,
        });
        return safeJson(result);
      },
    }),
  ];
}

export async function listCodeExecutionAudits(db: D1Like, projectId: string, limit = 20): Promise<CodeExecutionAuditRow[]> {
  const capped = Math.max(1, Math.min(100, Math.floor(limit)));
  const { results } = await db
    .prepare(
      `SELECT id, project_id, conversation_id, language, purpose, code_hash, code_preview,
              network_mode, status, error, result_preview, code_bytes, input_bytes,
              output_bytes, cpu_ms, subrequests, created_at, completed_at
         FROM coordinator_code_executions
        WHERE project_id=?
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .bind(projectId, capped)
    .all<{
      id: string;
      project_id: string;
      conversation_id: string | null;
      language: string;
      purpose: string;
      code_hash: string;
      code_preview: string;
      network_mode: string;
      status: string;
      error: string | null;
      result_preview: string | null;
      code_bytes: number;
      input_bytes: number;
      output_bytes: number | null;
      cpu_ms: number;
      subrequests: number;
      created_at: number;
      completed_at: number | null;
    }>();
  return (results ?? []).map((row) => ({
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    language: row.language,
    purpose: row.purpose,
    codeHash: row.code_hash,
    codePreview: row.code_preview,
    networkMode: row.network_mode,
    status: row.status,
    error: row.error,
    resultPreview: row.result_preview,
    codeBytes: Number(row.code_bytes),
    inputBytes: Number(row.input_bytes),
    outputBytes: row.output_bytes == null ? null : Number(row.output_bytes),
    cpuMs: Number(row.cpu_ms),
    subRequests: Number(row.subrequests),
    createdAt: Number(row.created_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
  }));
}

function normalizeLanguage(value: string): CodeLanguage {
  if (value === 'javascript' || value === 'python') return value;
  throw new Error('language must be "javascript" or "python"');
}

function normalizeNetwork(value: unknown): CodeNetworkMode {
  if (value == null || value === '') return 'open_public';
  if (value === 'open_public' || value === 'off') return value;
  throw new Error('network must be "open_public" or "off"');
}

function normalizePurpose(value: string): string {
  const purpose = value.trim();
  if (!purpose) throw new Error('purpose is required');
  return truncateToBytes(purpose, 500);
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? truncateToBytes(text, 500) : null;
}

async function insertAudit(db: D1Like, row: CodeExecutionAuditRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO coordinator_code_executions(
         id, project_id, conversation_id, language, purpose, code_hash, code_preview,
         network_mode, status, error, result_preview, code_bytes, input_bytes,
         output_bytes, cpu_ms, subrequests, created_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.projectId,
      row.conversationId,
      row.language,
      row.purpose,
      row.codeHash,
      row.codePreview,
      row.networkMode,
      row.status,
      row.error,
      row.resultPreview,
      row.codeBytes,
      row.inputBytes,
      row.outputBytes,
      row.cpuMs,
      row.subRequests,
      row.createdAt,
      row.completedAt,
    )
    .run();
}

async function updateAudit(
  db: D1Like,
  id: string,
  patch: { status: CodeExecutionStatus; error: string | null; resultPreview: string | null; outputBytes: number; completedAt: number },
): Promise<void> {
  await db
    .prepare(
      `UPDATE coordinator_code_executions
          SET status=?, error=?, result_preview=?, output_bytes=?, completed_at=?
        WHERE id=?`,
    )
    .bind(patch.status, patch.error, patch.resultPreview, patch.outputBytes, patch.completedAt, id)
    .run();
}

function preview(value: string): string {
  return redactSecrets(truncateToBytes(value, PREVIEW_BYTES));
}

async function hashText(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (bytes.some(Boolean)) return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}
