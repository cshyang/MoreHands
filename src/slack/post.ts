// Minimal Slack chat.postMessage / chat.update wrappers. Callers supply channel and token
// from trusted product routing; engaged answers use the durable outbox.

import { formatSlackText } from './format';
import type { SlackBlock } from './blocks';

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  httpStatus?: number;
  retryAfterSeconds?: number;
}

export interface SlackPostOptions {
  blocks?: SlackBlock[];
  format?: boolean;
  /** Per-message display identity (persona). Needs the chat:write.customize scope; when the scope
   *  is missing the post retries once without it. chat.update has no identity fields — edits
   *  inherit whatever the message was posted as, so the ack→reply chain keeps the persona. */
  username?: string;
  iconEmoji?: string;
  iconUrl?: string;
  /** Durable reply-part identity, used to reconcile an uncertain post against Slack history. */
  deliveryId?: string;
}

export class SlackApiError extends Error {
  constructor(
    public readonly code: string,
    metadata: { httpStatus?: unknown; retryAfterSeconds?: unknown } = {},
  ) {
    super(`slack API failed: ${code}`);
    if (isSafeHttpStatus(metadata.httpStatus)) this.httpStatus = metadata.httpStatus;
    if (isSafeRetryAfterSeconds(metadata.retryAfterSeconds)) this.retryAfterSeconds = metadata.retryAfterSeconds;
  }

  readonly httpStatus?: number;
  readonly retryAfterSeconds?: number;
}

function isSafeHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599;
}

function isSafeRetryAfterSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return isSafeRetryAfterSeconds(seconds) ? seconds : undefined;
}

async function rateLimitError(response: Response): Promise<SlackApiError> {
  let code = 'ratelimited';
  try {
    const data: unknown = await response.json();
    if (data && typeof data === 'object' && 'error' in data) {
      const error = (data as { error?: unknown }).error;
      if (error === 'rate_limited' || error === 'ratelimited') code = error;
    }
  } catch {
    // HTTP 429 is already positive evidence of rejection; a lost body stays retryable.
  }
  return new SlackApiError(code, { httpStatus: 429, retryAfterSeconds: retryAfterSeconds(response) });
}

function slackError(data: SlackApiResponse): SlackApiError {
  return new SlackApiError(data.error ?? 'unknown_error', {
    httpStatus: data.httpStatus,
    retryAfterSeconds: data.retryAfterSeconds,
  });
}

async function slackCall(method: 'chat.postMessage' | 'chat.update', token: string, body: Record<string, unknown>): Promise<SlackApiResponse> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 429) throw await rateLimitError(res);
  if (res.status >= 500) throw new Error(`Slack ${method} returned HTTP ${res.status}; outcome unknown`);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Slack ${method} returned a malformed response; outcome unknown`);
  }
  if (!data || typeof data !== 'object' || !('ok' in data) || typeof data.ok !== 'boolean') {
    throw new Error(`Slack ${method} returned a malformed response; outcome unknown`);
  }
  if (data.ok === false && (!('error' in data) || typeof data.error !== 'string' || !data.error)) {
    throw new Error(`Slack ${method} returned no rejection code; outcome unknown`);
  }
  return { ...(data as SlackApiResponse), httpStatus: res.status, retryAfterSeconds: retryAfterSeconds(res) };
}

// Returns the posted message's ts, so the caller can later edit it in place (chat.update).
export async function postMessage(
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
  options: SlackPostOptions = {},
): Promise<string | undefined> {
  const formatted = options.format === false ? text : formatSlackText(text);
  const body: Record<string, unknown> = {
    channel,
    text: formatted,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    ...(options.blocks ? { blocks: options.blocks } : {}),
    ...(options.username ? { username: options.username } : {}),
    ...(options.iconEmoji ? { icon_emoji: options.iconEmoji } : {}),
    ...(options.iconUrl ? { icon_url: options.iconUrl } : {}),
    ...(options.deliveryId ? { metadata: { event_type: 'morehands_reply', event_payload: { delivery_id: options.deliveryId } } } : {}),
  };
  let data = await slackCall('chat.postMessage', token, body);
  // Persona identity is best-effort: an app without chat:write.customize must still reply.
  if (!data.ok && data.error === 'missing_scope' && (body.username || body.icon_emoji || body.icon_url)) {
    console.log('[post] chat:write.customize scope missing — posting without persona identity');
    delete body.username;
    delete body.icon_emoji;
    delete body.icon_url;
    data = await slackCall('chat.postMessage', token, body);
  }
  if (!data.ok) throw slackError(data);
  return data.ts;
}

// Edit a known message in place for progress/receipt chrome and explicit posting tools.
// Engaged final answers are separate posts so a late progress edit cannot erase them.
export async function editMessage(
  token: string,
  channel: string,
  ts: string,
  text: string,
  options: SlackPostOptions = {},
): Promise<void> {
  const formatted = options.format === false ? text : formatSlackText(text);
  const data = await slackCall('chat.update', token, {
    channel,
    ts,
    text: formatted,
    ...(options.blocks ? { blocks: options.blocks } : {}),
  });
  if (!data.ok) throw slackError(data);
}

// Best-effort emoji reaction for an additional message joining a live response.
// Never throws: a missing reactions:write scope must not block native dispatch.
export async function addReaction(token: string, channel: string, ts: string, name: string): Promise<void> {
  try {
    const res = await fetch('https://slack.com/api/reactions.add', {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel, timestamp: ts, name }),
    });
    const data = (await res.json()) as SlackApiResponse;
    if (!data.ok && data.error !== 'already_reacted') {
      console.log(`[post] reactions.add failed: ${data.error ?? 'unknown_error'}`);
    }
  } catch (e) {
    console.log(`[post] reactions.add failed: ${e instanceof Error ? e.message : 'error'}`);
  }
}
