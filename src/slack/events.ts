export interface SlackEventEnvelope {
  api_app_id?: string;
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    user?: string;
    text?: string;
    channel_type?: string;
    files?: Array<{ id?: string; name?: string; mimetype?: string; size?: number }>;
  };
}

// Safe subset of Slack file metadata. No url_private — downloads go through
// files.info with the bot token at tool time, never through model context.
export interface SlackFileMeta {
  id: string;
  name: string | null;
  mimetype: string | null;
  size: number | null;
}

export function slackFileMetadata(value: unknown): SlackFileMeta[] {
  if (!Array.isArray(value)) return [];
  return value.filter((file) => file && typeof file.id === 'string' && file.id.trim())
    .map((file) => ({ id: file.id.trim(), name: typeof file.name === 'string' ? file.name : null,
      mimetype: typeof file.mimetype === 'string' ? file.mimetype : null,
      size: typeof file.size === 'number' && Number.isFinite(file.size) && file.size >= 0 ? file.size : null }));
}

export interface SlackUserMessageEvent {
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  text?: string;
  /** Slack channel type: 'im' (DM), 'channel', 'group', 'mpim'. Drives DM-vs-channel engagement. */
  channelType?: string;
  files?: SlackFileMeta[];
}

/** A DM (1:1) is always engaged — every non-trivial message is for the agent, no @mention needed. */
export function isDirectMessage(ev: Pick<SlackUserMessageEvent, 'channelType'>): boolean {
  return ev.channelType === 'im';
}

export function parseSlackEventEnvelope(raw: string): SlackEventEnvelope {
  return JSON.parse(raw) as SlackEventEnvelope;
}

export function slackUrlVerification(body: SlackEventEnvelope): { challenge?: string } | null {
  return body.type === 'url_verification' ? { challenge: body.challenge } : null;
}

// Ignore non-user messages, bot echoes, and all subtypes EXCEPT `file_share` — a user message
// with attached files arrives as that subtype, so dropping it would silently eat every upload.
// Dropping the rest also drops `thread_broadcast`; intentional until Slack needs that path to
// keep a thread alive.
export function slackUserMessageEvent(body: SlackEventEnvelope): SlackUserMessageEvent | null {
  const ev = body.event;
  if (!ev || ev.type !== 'message' || ev.bot_id || !ev.channel || !ev.ts) {
    return null;
  }
  if (ev.subtype && ev.subtype !== 'file_share') return null;

  const files = slackFileMetadata(ev.files);

  return {
    channel: ev.channel,
    ts: ev.ts,
    thread_ts: ev.thread_ts,
    user: ev.user,
    text: ev.text,
    ...(ev.channel_type ? { channelType: ev.channel_type } : {}),
    ...(files.length ? { files } : {}),
  };
}

export function slackEventId(body: SlackEventEnvelope, ev: SlackUserMessageEvent): string {
  return body.event_id ?? `${ev.channel}:${ev.ts}`;
}

/** Only call after signature verification of strictly decoded, bounded original bytes. */
export async function verifiedIngressEvent(raw: string, body: SlackEventEnvelope, event: SlackUserMessageEvent): Promise<import('./ingress-store').VerifiedIngressEvent> {
  if (typeof event.channel !== 'string' || !event.channel || typeof event.ts !== 'string'
    || (event.user !== undefined && typeof event.user !== 'string') || (event.text !== undefined && typeof event.text !== 'string')
    || (event.thread_ts !== undefined && typeof event.thread_ts !== 'string')
    || (event.channelType !== undefined && typeof event.channelType !== 'string')
    || typeof body.team_id !== 'string' || !body.team_id || typeof body.event_id !== 'string' || !body.event_id
    || /[\s\u0000-\u001f\u007f]/.test(`${body.team_id}:${body.event_id}`)
    || `slack:${body.team_id}:${body.event_id}`.length > 256
    || !/^\d+\.\d+$/.test(event.ts) || (event.thread_ts !== undefined && !/^\d+\.\d+$/.test(event.thread_ts))) {
    throw new Error('Invalid verified Slack event identity');
  }
  const bytes = new TextEncoder().encode(raw);
  if (bytes.length > 1_000_000) throw new Error('Slack event exceeds acceptance bound');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2,'0')).join('');
  const eventJson = JSON.stringify({ type: 'event_callback', team_id: body.team_id, event_id: body.event_id,
    ...(typeof body.api_app_id === 'string' ? { api_app_id: body.api_app_id } : {}),
    event: { type: 'message', channel: event.channel, ts: event.ts,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}), ...(event.user ? { user: event.user } : {}),
      ...(typeof event.text === 'string' ? { text: event.text } : {}),
      ...(event.channelType ? { channel_type: event.channelType } : {}),
      ...(event.files?.length ? { files: event.files } : {}) } });
  if (new TextEncoder().encode(eventJson).length > 1_000_000) throw new Error('Slack event exceeds sanitized bound');
  return { key: `${body.team_id}:${body.event_id}`, teamId: body.team_id, eventId: body.event_id, digest, eventJson };
}
