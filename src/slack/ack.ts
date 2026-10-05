import { postMessage as defaultPostMessage, type SlackPostOptions } from './post';
import { personaIdentity, type Persona } from '../project/persona';

// The instant, deterministic "working" acknowledgement. Posted from the gateway into the reply's
// thread the moment we engage, so a person never stares at silence while the agent turn spins up.
// Naming the specific step is the model's job via update_status; this is just the guaranteed baseline.
// A rotating pool (Claude Code spinner style) so a busy channel doesn't read like a stuck record;
// every line must telegraph "received, working" at a glance regardless of which one lands.
export const WORKING_ACKS: readonly string[] = [
  '👀 On it…',
  '🐦 Swooping in…',
  '🔍 Digging in…',
  '🧠 Pondering…',
  '🛠️ Tinkering…',
  '📜 Checking my notes…',
  '🪶 Ruffling feathers…',
  '⚙️ Cranking…',
  '🗺️ Charting a course…',
  '☕ Brewing an answer…',
];
/** A random working ack — the default text for postWorkingAck. */
export function pickWorkingAck(random: () => number = Math.random): string {
  return WORKING_ACKS[Math.min(Math.floor(random() * WORKING_ACKS.length), WORKING_ACKS.length - 1)];
}
export const SETUP_FAILURE_FALLBACK =
  'I hit an internal error after starting. Try again in a moment; if it repeats, an operator needs to check the logs.';

interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export type SlackPostMessage = (token: string, channel: string, text: string, threadTs?: string) => Promise<void>;

// Like SlackPostMessage but surfaces the posted ts, so the ack can later be edited in place.
export type SlackPostMessageReturningTs = (
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
  options?: SlackPostOptions,
) => Promise<string | undefined>;

export interface PostWorkingAckInput {
  token?: string;
  channel: string;
  threadTs: string;
  text?: string;
  /** Persona identity for the ack. Edits inherit the posted identity, so putting the persona on
   *  the ack is what makes the whole evolving message (receipts → final reply) wear it. */
  persona?: Persona | null;
}

export interface PostWorkingAckDeps {
  postMessage?: SlackPostMessageReturningTs;
  log?: (message: string) => void;
  timeoutMs?: number;
  trackPost?: (promise: Promise<unknown>) => void;
}

// Ceiling on how long we'll wait for the ack's ts before giving up and dispatching anyway. Keeps
// the original invariant — a slow/hung Slack must NEVER block the turn from dispatching (that would
// be the very silence the ack exists to prevent). Well under Slack's 3s event-ack budget.
export const ACK_POST_TIMEOUT_MS = 1500;

// The setup-failure fallback still fires-and-forgets via waitUntil — it's a terminal message with
// no ts to thread anywhere, so it keeps the lightweight shape.
export interface QueueWorkingAckInput {
  executionCtx: WaitUntilContext;
  token?: string;
  channel: string;
  threadTs: string;
  text?: string;
}

export interface QueueWorkingAckDeps {
  postMessage?: SlackPostMessage;
  log?: (message: string) => void;
}

// Post the ack and return its ts so the turn can EDIT it into the real reply (one evolving message).
// Awaited (not waitUntil): we need the ts before building the dispatch input. But the wait is bounded
// and failure-proof — a Slack hiccup, error, or timeout returns undefined (logged), and the turn
// dispatches anyway with the reply falling back to a fresh post. Returns undefined with no token too.
// A redelivery after a slow post is deduped by the already-claimed event_id upstream.
export async function postWorkingAck(
  { token, channel, threadTs, text = pickWorkingAck(), persona }: PostWorkingAckInput,
  deps: PostWorkingAckDeps = {},
): Promise<string | undefined> {
  if (!token) return undefined;

  const postMessage = deps.postMessage ?? defaultPostMessage;
  const log = deps.log ?? console.log;
  const timeoutMs = deps.timeoutMs ?? ACK_POST_TIMEOUT_MS;
  const identity = persona ? personaIdentity(persona) : undefined;

  // .catch on the post itself (not a try/catch around the race) so a rejection AFTER the timeout has
  // already won can't surface as an unhandled rejection.
  const rawPost = postMessage(token, channel, text, threadTs, identity);
  deps.trackPost?.(rawPost);
  const post = rawPost.catch((e) => {
    log(`[ack] working-ack failed to post: ${e instanceof Error ? e.message : 'error'}`);
    return undefined;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      log(`[ack] working-ack timed out after ${timeoutMs}ms; dispatching without edit-in-place`);
      resolve(undefined);
    }, timeoutMs);
  });

  try {
    return await Promise.race([post, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function queueSetupFailureFallback(
  input: QueueWorkingAckInput,
  deps: QueueWorkingAckDeps = {},
): void {
  queueSlackMessage({ ...input, text: input.text ?? SETUP_FAILURE_FALLBACK }, '[ack] setup-failure fallback failed to post', deps);
}

function queueSlackMessage(
  { executionCtx, token, channel, threadTs, text }: QueueWorkingAckInput & { text: string },
  logPrefix: string,
  deps: QueueWorkingAckDeps,
): void {
  if (!token) return;

  const postMessage = deps.postMessage ?? defaultPostMessage;
  const log = deps.log ?? console.log;

  executionCtx.waitUntil(
    postMessage(token, channel, text, threadTs).catch((e) =>
      log(`${logPrefix}: ${e instanceof Error ? e.message : 'error'}`),
    ),
  );
}
