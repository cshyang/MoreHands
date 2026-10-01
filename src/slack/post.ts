// Minimal Slack chat.postMessage / chat.update wrappers. Callers supply channel and token
// from trusted product routing; engaged answers use the durable outbox.

import { formatSlackText } from './format';
import type { SlackBlock } from './blocks';

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
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
  constructor(public readonly code: string) {
    super(`slack API failed: ${code}`);
  }
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
  if (res.status >= 500) throw new Error(`Slack ${method} returned HTTP ${res.status}; outcome unknown`);
  const data: unknown = await res.json();
  if (!data || typeof data !== 'object' || !('ok' in data) || typeof data.ok !== 'boolean') {
    throw new Error(`Slack ${method} returned a malformed response; outcome unknown`);
  }
  if (data.ok === false && (!('error' in data) || typeof data.error !== 'string' || !data.error)) {
    throw new Error(`Slack ${method} returned no rejection code; outcome unknown`);
  }
  return data as SlackApiResponse;
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
  if (!data.ok) throw new SlackApiError(data.error ?? 'unknown_error');
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
  if (!data.ok) throw new SlackApiError(data.error ?? 'unknown_error');
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
