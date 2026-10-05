import { SlackApiError } from './post';

export interface FindPostedReplyOptions {
  maxPages?: number;
  pageSize?: number;
  oldestTs?: string;
  /** Configured Slack bot USER id (U…), despite the binding field's historical name. */
  botId?: string;
  appId?: string;
}

interface HistoryMessage {
  ts?: unknown;
  thread_ts?: unknown;
  channel?: unknown;
  user?: unknown;
  bot_id?: unknown;
  app_id?: unknown;
  metadata?: {
    event_type?: unknown;
    event_payload?: { delivery_id?: unknown };
  };
}

const SLACK_TS = /^\d+(?:\.\d+)?$/;

/** A missing result is NOT permission to repost: Slack may have accepted the first request.
 *  Positive metadata matches repair the outbox; unresolved posts stay visible for inspection. */
export async function findPostedReply(
  token: string,
  channel: string,
  deliveryId: string,
  threadTs?: string,
  options: FindPostedReplyOptions = {},
): Promise<string | null> {
  validateTime(threadTs, 'threadTs');
  validateTime(options.oldestTs, 'oldestTs');
  validatePositiveInteger(options.maxPages, 'maxPages');
  validatePositiveInteger(options.pageSize, 'pageSize');
  validateIdentifier(options.botId, 'botId');
  validateIdentifier(options.appId, 'appId');

  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
  const pageSize = options.pageSize ?? 100;
  const oldest = options.oldestTs === undefined ? undefined : Number(options.oldestTs);
  const seenCursors = new Set<string>();
  const matches: string[] = [];
  let metadataMismatch = false;
  let exhausted = false;
  let cursor = '';

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`https://slack.com/api/${threadTs ? 'conversations.replies' : 'conversations.history'}`);
    url.searchParams.set('channel', channel);
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('include_all_metadata', 'true');
    if (options.oldestTs !== undefined) {
      url.searchParams.set('oldest', options.oldestTs);
      url.searchParams.set('inclusive', 'true');
    }
    if (threadTs !== undefined) url.searchParams.set('ts', threadTs);
    if (cursor) url.searchParams.set('cursor', cursor);

    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (response.status === 429) throw await historyRateLimitError(response);
    if (response.status >= 500) {
      throw new Error(`Slack history returned HTTP ${response.status}; outcome unknown`);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new Error('Slack history returned a malformed response; outcome unknown');
    }
    if (!data || typeof data !== 'object' || !('ok' in data) || typeof data.ok !== 'boolean') {
      throw new Error('Slack history returned a malformed response; outcome unknown');
    }
    const pageData = data as { ok: boolean; error?: unknown; messages?: unknown; response_metadata?: unknown };
    if (!pageData.ok) {
      if (typeof pageData.error !== 'string' || !pageData.error) {
        throw new Error('Slack history returned no rejection code; outcome unknown');
      }
      throw new SlackApiError(pageData.error, { httpStatus: response.status, retryAfterSeconds: retryAfter(response) });
    }
    if (pageData.messages !== undefined && !Array.isArray(pageData.messages)) {
      throw new Error('Slack history returned malformed messages; outcome unknown');
    }

    for (const value of (pageData.messages ?? []) as unknown[]) {
      if (!value || typeof value !== 'object') {
        throw new Error('Slack history returned a malformed message; outcome unknown');
      }
      const message = value as HistoryMessage;
      if (!hasDeliveryMetadata(message, deliveryId)) continue;
      if (!isTrustedMatch(message, channel, threadTs, oldest, options)) {
        metadataMismatch = true;
        continue;
      }
      matches.push(message.ts);
    }

    let nextCursor = '';
    const metadata = pageData.response_metadata;
    if (metadata !== undefined) {
      if (typeof metadata !== 'object' || metadata === null || !('next_cursor' in metadata)) {
        throw new Error('Slack history returned malformed pagination metadata; outcome unknown');
      }
      const next = (metadata as { next_cursor?: unknown }).next_cursor ?? '';
      if (typeof next !== 'string') {
        throw new Error('Slack history returned a malformed cursor; outcome unknown');
      }
      nextCursor = next;
    }
    if (!nextCursor) { exhausted = true; break; }
    if (seenCursors.has(nextCursor)) throw new Error('repeated Slack history cursor; outcome unknown');
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  if (!exhausted || metadataMismatch || matches.length !== 1) return null;
  return matches[0];
}

function validateTime(value: string | undefined, name: string): void {
  if (value !== undefined && !isSlackTs(value)) {
    throw new Error(`Invalid Slack reconciliation options: ${name}`);
  }
}

function isSlackTs(value: unknown): value is string {
  return typeof value === 'string' && SLACK_TS.test(value) && Number.isFinite(Number(value));
}

function validatePositiveInteger(value: number | undefined, name: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1 || (name === 'pageSize' && value > 1000)) {
    throw new Error(`Invalid Slack reconciliation options: ${name}`);
  }
}

function validateIdentifier(value: string | undefined, name: string): void {
  if (value !== undefined && !value) throw new Error(`Invalid Slack reconciliation options: ${name}`);
}

function hasDeliveryMetadata(message: HistoryMessage, deliveryId: string): boolean {
  return message.metadata?.event_type === 'morehands_reply'
    && message.metadata.event_payload?.delivery_id === deliveryId;
}

function isTrustedMatch(
  message: HistoryMessage,
  channel: string,
  threadTs: string | undefined,
  oldest: number | undefined,
  options: FindPostedReplyOptions,
): message is HistoryMessage & { ts: string } {
  if (!isSlackTs(message.ts)) return false;
  if (oldest !== undefined && Number(message.ts) < oldest) return false;
  if (message.channel !== undefined && (typeof message.channel !== 'string' || message.channel !== channel)) return false;
  if (message.thread_ts !== undefined && (typeof message.thread_ts !== 'string' || message.thread_ts !== threadTs)) return false;
  if (options.botId === undefined && options.appId === undefined) return true;
  // botId is the configured bot USER id. A persona row can omit user entirely; a trusted
  // matching app_id positively identifies it without comparing transportBotId to bot_id.
  if (message.user !== undefined && typeof message.user !== 'string') return false;
  if (message.app_id !== undefined && typeof message.app_id !== 'string') return false;
  const userMatches = options.botId !== undefined && message.user === options.botId;
  if (options.appId === undefined) return userMatches;
  if (message.app_id !== options.appId) return false;
  return message.user === undefined ? true : userMatches;
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

async function historyRateLimitError(response: Response): Promise<SlackApiError> {
  let code = 'ratelimited';
  try {
    const data: unknown = await response.json();
    if (data && typeof data === 'object' && 'error' in data) {
      const error = (data as { error?: unknown }).error;
      if (error === 'rate_limited' || error === 'ratelimited') code = error;
    }
  } catch {
    // The observed status is sufficient evidence; a missing body does not make the outcome unknown.
  }
  return new SlackApiError(code, { httpStatus: 429, retryAfterSeconds: retryAfter(response) });
}
