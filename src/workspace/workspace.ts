import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { D1Like } from '../skills/repository';
import { byteLength, redactSecrets, safeJson, truncateToBytes } from '../shared/bounded';
import { withWallClock } from '../shared/wall-clock';

export type WorkspaceOp = 'exec' | 'write_file' | 'read_file' | 'load_slack_file' | 'send_file';
export type WorkspaceOpStatus = 'running' | 'completed' | 'failed';

// Structural subset of @cloudflare/sandbox's Sandbox stub — keeps this module
// platform-agnostic and testable with fakes. The real stub satisfies it as-is.
export interface SandboxLike {
  exec(command: string, options?: { timeout?: number; cwd?: string }): Promise<{
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  writeFile(path: string, content: string, options?: { encoding?: string }): Promise<{ success: boolean }>;
  readFile(path: string, options?: { encoding?: string }): Promise<{ success: boolean; content: string }>;
}

// Lazy: the container boots on first operation, so tools receive a thunk and
// only resolve it when the model actually uses the workspace.
export type SandboxFactory = () => SandboxLike;

export interface WorkspaceLimits {
  execTimeoutMs: number;
  maxExecTimeoutMs: number;
  maxOutputBytes: number;
  maxWriteBytes: number;
  maxReadBytes: number;
  /** Client-side headroom past the container-enforced exec timeout before the
   *  wall-clock race gives up on the RPC (covers ~6s cold start + transit). */
  execClientGraceMs: number;
  /** Wall-clock bound on file-op RPCs, which have no container-side timeout. */
  fileOpWallClockMs: number;
}

const DEFAULT_LIMITS: WorkspaceLimits = {
  execTimeoutMs: 60_000,
  maxExecTimeoutMs: 300_000,
  maxOutputBytes: 20_000,
  maxWriteBytes: 1_000_000,
  maxReadBytes: 1_000_000,
  execClientGraceMs: 15_000,
  fileOpWallClockMs: 30_000,
};

const PREVIEW_BYTES = 2000;

export function workspaceLimits(env: Record<string, unknown> = {}): WorkspaceLimits {
  return {
    execTimeoutMs: positiveInt(env.WORKSPACE_EXEC_TIMEOUT_MS, DEFAULT_LIMITS.execTimeoutMs),
    maxExecTimeoutMs: positiveInt(env.WORKSPACE_MAX_EXEC_TIMEOUT_MS, DEFAULT_LIMITS.maxExecTimeoutMs),
    maxOutputBytes: positiveInt(env.WORKSPACE_MAX_OUTPUT_BYTES, DEFAULT_LIMITS.maxOutputBytes),
    maxWriteBytes: positiveInt(env.WORKSPACE_MAX_WRITE_BYTES, DEFAULT_LIMITS.maxWriteBytes),
    maxReadBytes: positiveInt(env.WORKSPACE_MAX_READ_BYTES, DEFAULT_LIMITS.maxReadBytes),
    execClientGraceMs: positiveInt(env.WORKSPACE_EXEC_CLIENT_GRACE_MS, DEFAULT_LIMITS.execClientGraceMs),
    fileOpWallClockMs: positiveInt(env.WORKSPACE_FILE_WALL_CLOCK_MS, DEFAULT_LIMITS.fileOpWallClockMs),
  };
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function hasWorkspaceCapability(args: { db?: D1Like; sandbox?: SandboxFactory }): boolean {
  return !!args.db && !!args.sandbox;
}

export interface WorkspaceOpAuditRow {
  id: string;
  projectId: string;
  conversationId: string | null;
  op: string;
  detailPreview: string;
  status: string;
  error: string | null;
  resultPreview: string | null;
  exitCode: number | null;
  bytesIn: number;
  bytesOut: number | null;
  createdAt: number;
  completedAt: number | null;
}

export interface WorkspaceDeps {
  db: D1Like;
  sandbox: SandboxFactory;
  projectId: string;
  env?: Record<string, unknown>;
  now?: () => number;
  id?: () => string;
}

export interface WorkspaceExecResult {
  opId: string;
  status: 'completed' | 'failed';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  error: string | null;
  durationMs: number;
}

export async function workspaceExec(
  deps: WorkspaceDeps,
  params: { command: string; timeoutMs?: number; cwd?: string; conversationId?: string },
): Promise<WorkspaceExecResult> {
  const limits = workspaceLimits(deps.env);
  const command = params.command?.trim();
  const op = await beginWorkspaceOp(deps, {
    op: 'exec',
    detail: command || '(empty command)',
    conversationId: params.conversationId,
    bytesIn: byteLength(command ?? ''),
  });

  if (!command) return op.failExec('command is required');

  const timeout = Math.min(positiveInt(params.timeoutMs, limits.execTimeoutMs), limits.maxExecTimeoutMs);
  try {
    // `timeout` is enforced inside the container; if the container itself dies
    // mid-exec (deploys replace containers) the RPC await hangs with no error.
    // Client-side race at timeout + grace converts that into a failed op.
    const result = await withWallClock(
      deps.sandbox().exec(command, { timeout, cwd: params.cwd ?? '/workspace' }),
      timeout + limits.execClientGraceMs,
      'workspace_exec',
    );
    const stdout = truncateToBytes(result.stdout ?? '', limits.maxOutputBytes);
    const stderr = truncateToBytes(result.stderr ?? '', limits.maxOutputBytes);
    const truncated = stdout !== (result.stdout ?? '') || stderr !== (result.stderr ?? '');
    const completedAt = await op.complete({
      resultPreview: preview(`exit=${result.exitCode} stdout: ${result.stdout ?? ''} stderr: ${result.stderr ?? ''}`),
      exitCode: result.exitCode,
      bytesOut: byteLength(result.stdout ?? '') + byteLength(result.stderr ?? ''),
    });
    return {
      opId: op.id,
      status: 'completed',
      exitCode: result.exitCode,
      stdout: redactSecrets(stdout),
      stderr: redactSecrets(stderr),
      truncated,
      error: null,
      durationMs: completedAt - op.startedAt,
    };
  } catch (e) {
    return op.failExec(e instanceof Error ? e.message : String(e));
  }
}

export interface WorkspaceFileResult {
  opId: string;
  status: 'completed' | 'failed';
  path: string;
  content: string | null;
  bytes: number;
  truncated: boolean;
  error: string | null;
  durationMs: number;
}

export async function workspaceWriteFile(
  deps: WorkspaceDeps,
  params: { path: string; content: string; conversationId?: string },
): Promise<WorkspaceFileResult> {
  const limits = workspaceLimits(deps.env);
  const path = params.path?.trim() ?? '';
  const content = params.content ?? '';
  const contentBytes = byteLength(content);
  const op = await beginWorkspaceOp(deps, {
    op: 'write_file',
    detail: path || '(missing path)',
    conversationId: params.conversationId,
    bytesIn: contentBytes,
  });

  if (!path) return op.failFile(path, 'path is required');
  if (contentBytes > limits.maxWriteBytes) {
    return op.failFile(path, `content is too large (${contentBytes} bytes > ${limits.maxWriteBytes} bytes)`);
  }

  try {
    const result = await withWallClock(deps.sandbox().writeFile(path, content), limits.fileOpWallClockMs, 'workspace_write_file');
    if (!result.success) return op.failFile(path, 'sandbox write failed');
    const completedAt = await op.complete({ resultPreview: preview(`wrote ${contentBytes} bytes to ${path}`), exitCode: null, bytesOut: contentBytes });
    return { opId: op.id, status: 'completed', path, content: null, bytes: contentBytes, truncated: false, error: null, durationMs: completedAt - op.startedAt };
  } catch (e) {
    return op.failFile(path, e instanceof Error ? e.message : String(e));
  }
}

export async function workspaceReadFile(
  deps: WorkspaceDeps,
  params: { path: string; maxBytes?: number; conversationId?: string },
): Promise<WorkspaceFileResult> {
  const limits = workspaceLimits(deps.env);
  const path = params.path?.trim() ?? '';
  const op = await beginWorkspaceOp(deps, {
    op: 'read_file',
    detail: path || '(missing path)',
    conversationId: params.conversationId,
    bytesIn: 0,
  });

  if (!path) return op.failFile(path, 'path is required');
  const cap = Math.min(positiveInt(params.maxBytes, limits.maxReadBytes), limits.maxReadBytes);

  try {
    const result = await withWallClock(deps.sandbox().readFile(path), limits.fileOpWallClockMs, 'workspace_read_file');
    if (!result.success) return op.failFile(path, 'sandbox read failed');
    const full = result.content ?? '';
    const fullBytes = byteLength(full);
    const content = truncateToBytes(full, cap);
    const completedAt = await op.complete({ resultPreview: preview(`read ${fullBytes} bytes from ${path}`), exitCode: null, bytesOut: fullBytes });
    return {
      opId: op.id,
      status: 'completed',
      path,
      content: redactSecrets(content),
      bytes: fullBytes,
      truncated: fullBytes > cap,
      error: null,
      durationMs: completedAt - op.startedAt,
    };
  } catch (e) {
    return op.failFile(path, e instanceof Error ? e.message : String(e));
  }
}

export function workspaceTools(args: {
  db?: D1Like;
  sandbox?: SandboxFactory;
  projectId: string;
  env?: Record<string, unknown>;
}): ToolDefinition[] {
  if (!hasWorkspaceCapability(args)) return [];
  const deps: WorkspaceDeps = { db: args.db!, sandbox: args.sandbox!, projectId: args.projectId, env: args.env };
  return [
    defineTool({
      name: 'workspace_exec',
      description:
        'Run a shell command in this project\'s sandbox container (Ubuntu with git, node, python3 + pandas/numpy). Use for files, spreadsheets, and multi-step data work; use execute_code for small pure functions instead. Working dir defaults to /workspace. The filesystem is EPHEMERAL: the container sleeps after ~10 idle minutes and loses all files, so verify inputs exist before reusing prior state. First command after idle pays a ~6s container start.',
      input: v.object({
        command: v.pipe(v.string(), v.description('Shell command to run (bash -c semantics).')),
        timeoutMs: v.optional(v.pipe(v.number(), v.description('Timeout in ms. Default 60000, hard cap 300000.'))),
        cwd: v.optional(v.pipe(v.string(), v.description('Working directory. Defaults to /workspace.'))),
        conversationId: v.optional(v.pipe(v.string(), v.description('Copy from the current Dispatch Input when available.'))),
      }),
      async run({ data: params }) {
        return safeJson(await workspaceExec(deps, params as { command: string; timeoutMs?: number; cwd?: string; conversationId?: string }));
      },
    }),
    defineTool({
      name: 'workspace_write_file',
      description:
        'Write a text file into the project sandbox container (e.g. a script to run with workspace_exec). Content is capped (~1MB).',
      input: v.object({
        path: v.pipe(v.string(), v.description('Absolute path inside the container, e.g. /workspace/script.py.')),
        content: v.pipe(v.string(), v.description('Full file content (text).')),
        conversationId: v.optional(v.pipe(v.string(), v.description('Copy from the current Dispatch Input when available.'))),
      }),
      async run({ data: params }) {
        return safeJson(await workspaceWriteFile(deps, params as { path: string; content: string; conversationId?: string }));
      },
    }),
    defineTool({
      name: 'workspace_read_file',
      description:
        'Read a text file from the project sandbox container into the conversation. Output is capped (~1MB, truncated flag set); for large results prefer summarizing via workspace_exec.',
      input: v.object({
        path: v.pipe(v.string(), v.description('Absolute path inside the container.')),
        maxBytes: v.optional(v.pipe(v.number(), v.description('Optional tighter cap on returned bytes.'))),
        conversationId: v.optional(v.pipe(v.string(), v.description('Copy from the current Dispatch Input when available.'))),
      }),
      async run({ data: params }) {
        return safeJson(await workspaceReadFile(deps, params as { path: string; maxBytes?: number; conversationId?: string }));
      },
    }),
  ];
}

export async function listWorkspaceOps(db: D1Like, projectId: string, limit = 20): Promise<WorkspaceOpAuditRow[]> {
  const capped = Math.max(1, Math.min(100, Math.floor(limit)));
  const { results } = await db
    .prepare(
      `SELECT id, project_id, conversation_id, op, detail_preview, status, error,
              result_preview, exit_code, bytes_in, bytes_out, created_at, completed_at
         FROM coordinator_workspace_ops
        WHERE project_id=?
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .bind(projectId, capped)
    .all<{
      id: string;
      project_id: string;
      conversation_id: string | null;
      op: string;
      detail_preview: string;
      status: string;
      error: string | null;
      result_preview: string | null;
      exit_code: number | null;
      bytes_in: number;
      bytes_out: number | null;
      created_at: number;
      completed_at: number | null;
    }>();
  return (results ?? []).map((row) => ({
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    op: row.op,
    detailPreview: row.detail_preview,
    status: row.status,
    error: row.error,
    resultPreview: row.result_preview,
    exitCode: row.exit_code == null ? null : Number(row.exit_code),
    bytesIn: Number(row.bytes_in),
    bytesOut: row.bytes_out == null ? null : Number(row.bytes_out),
    createdAt: Number(row.created_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
  }));
}

export interface OpHandle {
  id: string;
  startedAt: number;
  complete(patch: { resultPreview: string; exitCode: number | null; bytesOut: number }): Promise<number>;
  failExec(message: string): Promise<WorkspaceExecResult>;
  failFile(path: string, message: string): Promise<WorkspaceFileResult>;
}

export async function beginWorkspaceOp(
  deps: WorkspaceDeps,
  args: { op: WorkspaceOp; detail: string; conversationId?: string; bytesIn: number },
): Promise<OpHandle> {
  const now = deps.now ?? Date.now;
  const id = deps.id ? deps.id() : `ws_${cryptoRandomId()}`;
  const startedAt = now();
  await deps.db
    .prepare(
      `INSERT INTO coordinator_workspace_ops(
         id, project_id, conversation_id, op, detail_preview, status, error,
         result_preview, exit_code, bytes_in, bytes_out, created_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, 'running', NULL, NULL, NULL, ?, NULL, ?, NULL)`,
    )
    .bind(id, deps.projectId, normalizeOptionalText(args.conversationId), args.op, preview(args.detail), args.bytesIn, startedAt)
    .run();

  const update = async (patch: { status: WorkspaceOpStatus; error: string | null; resultPreview: string | null; exitCode: number | null; bytesOut: number | null }) => {
    const completedAt = now();
    await deps.db
      .prepare(
        `UPDATE coordinator_workspace_ops
            SET status=?, error=?, result_preview=?, exit_code=?, bytes_out=?, completed_at=?
          WHERE id=?`,
      )
      .bind(patch.status, patch.error, patch.resultPreview, patch.exitCode, patch.bytesOut, completedAt, id)
      .run();
    return completedAt;
  };

  return {
    id,
    startedAt,
    complete: (patch) => update({ status: 'completed', error: null, ...patch }),
    async failExec(message) {
      const completedAt = await update({ status: 'failed', error: preview(message), resultPreview: null, exitCode: null, bytesOut: null });
      return { opId: id, status: 'failed', exitCode: null, stdout: '', stderr: '', truncated: false, error: message, durationMs: completedAt - startedAt };
    },
    async failFile(path, message) {
      const completedAt = await update({ status: 'failed', error: preview(message), resultPreview: null, exitCode: null, bytesOut: null });
      return { opId: id, status: 'failed', path, content: null, bytes: 0, truncated: false, error: message, durationMs: completedAt - startedAt };
    },
  };
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? truncateToBytes(text, 500) : null;
}

function preview(value: string): string {
  return redactSecrets(truncateToBytes(value, PREVIEW_BYTES));
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (bytes.some(Boolean)) return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}
