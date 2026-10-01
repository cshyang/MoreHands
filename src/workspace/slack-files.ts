// workspace_load_slack_file: pull a user-attached Slack file into the project sandbox.
//
// The bot token stays in the Worker — the tool resolves the download URL via files.info and
// streams bytes into the container as base64, so the container never sees a credential and the
// model never sees url_private. The container only boots when the model actually loads a file.

import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { D1Like } from '../skills/repository';
import { safeJson } from '../shared/bounded';
import { withWallClock } from '../shared/wall-clock';
import { isSlackConversationFileAllowed } from '../slack/file-authorizations';
import { beginWorkspaceOp, workspaceLimits, type SandboxFactory, type WorkspaceDeps } from './workspace';

export const WORKSPACE_INPUTS_DIR = '/workspace/inputs';

const DEFAULT_MAX_SLACK_FILE_BYTES = 20_000_000;

export interface SlackFileDeps extends WorkspaceDeps {
  token: string;
  fetcher?: typeof fetch;
}

// Destination resolution mirrors reply_to_conversation: the model supplies only a
// conversationId; channel/thread/token come from trusted config, never from the model.
export type SlackTargetResolver = (
  conversationId: string,
) => Promise<{ channelId: string; threadTs: string | null; token: string } | null>;

export interface SlackSendDeps extends WorkspaceDeps {
  resolveTarget: SlackTargetResolver;
  fetcher?: typeof fetch;
}

export interface LoadSlackFileResult {
  opId: string;
  status: 'completed' | 'failed';
  path: string | null;
  name: string | null;
  mimetype: string | null;
  bytes: number;
  error: string | null;
  durationMs: number;
}

interface SlackFilesInfoResponse {
  ok: boolean;
  error?: string;
  file?: {
    id?: string;
    name?: string;
    mimetype?: string;
    size?: number;
    url_private_download?: string;
    url_private?: string;
  };
}

export function maxSlackFileBytes(env: Record<string, unknown> = {}): number {
  const value = env.WORKSPACE_MAX_SLACK_FILE_BYTES;
  if (typeof value !== 'string' && typeof value !== 'number') return DEFAULT_MAX_SLACK_FILE_BYTES;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_SLACK_FILE_BYTES;
}

export async function workspaceLoadSlackFile(
  deps: SlackFileDeps,
  params: { fileId: string; conversationId?: string },
): Promise<LoadSlackFileResult> {
  const fetcher = deps.fetcher ?? fetch;
  const cap = maxSlackFileBytes(deps.env);
  const fileId = params.fileId?.trim() ?? '';
  const conversationId = params.conversationId?.trim() ?? '';
  const op = await beginWorkspaceOp(deps, {
    op: 'load_slack_file',
    detail: fileId || '(missing file id)',
    conversationId,
    bytesIn: 0,
  });

  const fail = async (message: string): Promise<LoadSlackFileResult> => {
    const failed = await op.failFile(fileId, message);
    return { opId: failed.opId, status: 'failed', path: null, name: null, mimetype: null, bytes: 0, error: failed.error, durationMs: failed.durationMs };
  };

  if (!fileId) return fail('fileId is required');
  if (!conversationId) return fail('conversationId is required to load Slack files');

  const allowed = await isSlackConversationFileAllowed(deps.db, {
    projectId: deps.projectId,
    conversationId,
    fileId,
  });
  if (!allowed) {
    return fail('Slack file is not attached to this conversation');
  }

  try {
    const infoRes = await fetcher(`https://slack.com/api/files.info?file=${encodeURIComponent(fileId)}`, {
      headers: { authorization: `Bearer ${deps.token}` },
    });
    const info = (await infoRes.json()) as SlackFilesInfoResponse;
    if (!info.ok || !info.file) return fail(`Slack files.info failed: ${info.error ?? 'unknown error'}`);

    const declaredSize = typeof info.file.size === 'number' ? info.file.size : null;
    if (declaredSize !== null && declaredSize > cap) {
      return fail(`file is too large (${declaredSize} bytes > ${cap} bytes)`);
    }

    const url = info.file.url_private_download ?? info.file.url_private;
    if (!url) return fail('Slack file has no downloadable URL');

    const download = await fetcher(url, { headers: { authorization: `Bearer ${deps.token}` } });
    if (!download.ok) return fail(`Slack file download failed: HTTP ${download.status}`);
    const buffer = await download.arrayBuffer();
    // Slack's declared size can lie (or be absent); the actual bytes are the contract.
    if (buffer.byteLength > cap) return fail(`file is too large (${buffer.byteLength} bytes > ${cap} bytes)`);

    const name = sanitizeFileName(info.file.name, fileId);
    const path = `${WORKSPACE_INPUTS_DIR}/${fileId}_${name}`;
    const sandbox = deps.sandbox();
    const wallClockMs = workspaceLimits(deps.env).fileOpWallClockMs;
    // Dead-container RPCs hang forever (see shared/wall-clock.ts) — bound both hops.
    await withWallClock(sandbox.exec(`mkdir -p ${WORKSPACE_INPUTS_DIR}`), wallClockMs, 'workspace_load_slack_file');
    const written = await withWallClock(sandbox.writeFile(path, toBase64(buffer), { encoding: 'base64' }), wallClockMs, 'workspace_load_slack_file');
    if (!written.success) return fail('sandbox write failed');

    const completedAt = await op.complete({
      resultPreview: `loaded ${buffer.byteLength} bytes to ${path}`,
      exitCode: null,
      bytesOut: buffer.byteLength,
    });
    return {
      opId: op.id,
      status: 'completed',
      path,
      name: info.file.name ?? name,
      mimetype: info.file.mimetype ?? null,
      bytes: buffer.byteLength,
      error: null,
      durationMs: completedAt - op.startedAt,
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export interface SendSlackFileResult {
  opId: string;
  status: 'completed' | 'failed';
  fileId: string | null;
  name: string | null;
  bytes: number;
  error: string | null;
  durationMs: number;
}

interface SlackUploadUrlResponse {
  ok: boolean;
  error?: string;
  upload_url?: string;
  file_id?: string;
}

export async function workspaceSendFile(
  deps: SlackSendDeps,
  params: { path: string; title?: string; conversationId?: string },
): Promise<SendSlackFileResult> {
  const fetcher = deps.fetcher ?? fetch;
  const cap = maxSlackFileBytes(deps.env);
  const path = params.path?.trim() ?? '';
  const op = await beginWorkspaceOp(deps, {
    op: 'send_file',
    detail: path || '(missing path)',
    conversationId: params.conversationId,
    bytesIn: 0,
  });

  const fail = async (message: string): Promise<SendSlackFileResult> => {
    const failed = await op.failFile(path, message);
    return { opId: failed.opId, status: 'failed', fileId: null, name: null, bytes: 0, error: failed.error, durationMs: failed.durationMs };
  };

  if (!path) return fail('path is required');

  try {
    const target = await deps.resolveTarget(params.conversationId?.trim() ?? '');
    if (!target) return fail(`No Slack target found for conversationId "${params.conversationId ?? ''}".`);

    const read = await withWallClock(deps.sandbox().readFile(path, { encoding: 'base64' }), workspaceLimits(deps.env).fileOpWallClockMs, 'workspace_send_file');
    if (!read.success) return fail('sandbox read failed');
    const bytes = fromBase64(read.content ?? '');
    if (bytes.byteLength === 0) return fail('file is empty or unreadable');
    if (bytes.byteLength > cap) return fail(`file is too large (${bytes.byteLength} bytes > ${cap} bytes)`);

    const filename = path.split('/').pop() || 'file';
    const urlRes = await fetcher('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ filename, length: String(bytes.byteLength) }).toString(),
    });
    const urlData = (await urlRes.json()) as SlackUploadUrlResponse;
    if (!urlData.ok || !urlData.upload_url || !urlData.file_id) {
      return fail(`Slack getUploadURLExternal failed: ${urlData.error ?? 'unknown error'}`);
    }

    const uploadRes = await fetcher(urlData.upload_url, { method: 'POST', body: bytes });
    if (!uploadRes.ok) return fail(`Slack file upload failed: HTTP ${uploadRes.status}`);

    const completeRes = await fetcher('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        files: [{ id: urlData.file_id, title: params.title?.trim() || filename }],
        channel_id: target.channelId,
        ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
      }),
    });
    const completeData = (await completeRes.json()) as { ok: boolean; error?: string };
    if (!completeData.ok) return fail(`Slack completeUploadExternal failed: ${completeData.error ?? 'unknown error'}`);

    const completedAt = await op.complete({
      resultPreview: `sent ${bytes.byteLength} bytes from ${path} as ${filename}`,
      exitCode: null,
      bytesOut: bytes.byteLength,
    });
    return {
      opId: op.id,
      status: 'completed',
      fileId: urlData.file_id,
      name: filename,
      bytes: bytes.byteLength,
      error: null,
      durationMs: completedAt - op.startedAt,
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export function workspaceSlackFileTools(args: {
  db?: D1Like;
  sandbox?: SandboxFactory;
  projectId: string;
  env?: Record<string, unknown>;
  token?: string;
  resolveTarget?: SlackTargetResolver;
  fetcher?: typeof fetch;
}): ToolDefinition[] {
  if (!args.db || !args.sandbox || !args.token) return [];
  const deps: SlackFileDeps = {
    db: args.db,
    sandbox: args.sandbox,
    projectId: args.projectId,
    env: args.env,
    token: args.token,
    fetcher: args.fetcher,
  };
  const resolveTarget = args.resolveTarget;
  const sendTools: ToolDefinition[] = resolveTarget
    ? [
        defineTool({
          name: 'workspace_send_file',
          description:
            'Upload a file from the sandbox container into the current Slack thread (e.g. a generated CSV or chart). Pass the container path; the destination is resolved from conversationId like reply_to_conversation. Size cap ~20MB. This shares the file — still send your text answer via reply_to_conversation.',
          input: v.object({
            path: v.pipe(v.string(), v.description('Absolute container path of the file to send, e.g. /workspace/out/result.csv.')),
            title: v.optional(v.pipe(v.string(), v.description('Display title in Slack. Defaults to the filename.'))),
            conversationId: v.optional(v.pipe(v.string(), v.description('Copy from the current Dispatch Input, same as your reply.'))),
          }),
          async run({ data: params }) {
            return safeJson(
              await workspaceSendFile(
                { db: deps.db, sandbox: deps.sandbox, projectId: deps.projectId, env: deps.env, resolveTarget, fetcher: deps.fetcher },
                params as { path: string; title?: string; conversationId?: string },
              ),
            );
          },
        }),
      ]
    : [];
  return [
    ...sendTools,
    defineTool({
      name: 'workspace_load_slack_file',
      description:
        `Download a file the user attached in Slack into this project's sandbox container under ${WORKSPACE_INPUTS_DIR}/, returning its container path. Use the file ids listed in attachedFiles on the current Dispatch Input. Size cap ~20MB. After loading, process the file with workspace_exec (python3 with pandas is available).`,
      input: v.object({
        fileId: v.pipe(v.string(), v.description('Slack file id from attachedFiles, e.g. F0123456789.')),
        conversationId: v.pipe(v.string(), v.description('Copy from the current Dispatch Input. Required: files can only be loaded from their attached conversation.')),
      }),
      async run({ data: params }) {
        return safeJson(await workspaceLoadSlackFile(deps, params as { fileId: string; conversationId?: string }));
      },
    }),
  ];
}

function sanitizeFileName(name: string | undefined, fallback: string): string {
  const base = (name ?? '').split('/').pop()?.split('\\').pop() ?? '';
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100);
  return safe || fallback;
}

function toBase64(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode(...view.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(content: string): Uint8Array<ArrayBuffer> {
  const binary = atob(content.replace(/\s+/g, ''));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
