import { SlackApiError } from './post';

/** A missing result is NOT permission to repost: Slack may have accepted the first request.
 *  Positive metadata matches repair the outbox; unresolved posts stay visible for inspection. */
export async function findPostedReply(
  token: string,
  channel: string,
  deliveryId: string,
  threadTs?: string,
): Promise<string | null> {
  let cursor = '';
  do {
    const url = new URL(`https://slack.com/api/${threadTs ? 'conversations.replies' : 'conversations.history'}`);
    url.searchParams.set('channel', channel);
    url.searchParams.set('limit', '100');
    url.searchParams.set('include_all_metadata', 'true');
    if (threadTs) url.searchParams.set('ts', threadTs);
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    const data = await response.json() as {
      ok: boolean; error?: string;
      messages?: Array<{ ts?: string; metadata?: { event_type?: string; event_payload?: { delivery_id?: string } } }>;
      response_metadata?: { next_cursor?: string };
    };
    if (!data.ok) throw new SlackApiError(data.error ?? 'unknown_error');
    const match = data.messages?.find((message) =>
      message.metadata?.event_type === 'morehands_reply' && message.metadata.event_payload?.delivery_id === deliveryId,
    );
    if (match?.ts) return match.ts;
    cursor = data.response_metadata?.next_cursor ?? '';
  } while (cursor);
  return null;
}
