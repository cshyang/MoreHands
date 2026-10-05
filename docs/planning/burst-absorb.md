# Burst-absorb: one coherent reply per message burst

**Historical reference:** This document describes an earlier runtime or experiment. Current production uses Flue 2.2.2; see the [completed cutover](../operations/2026-10-05-flue-cutover.md) and [deployment runbook](../deployment.md). Earlier reset, replay and deployment proposals are not current operating instructions. Unimplemented follow-up ideas remain proposals.

The former application burst-absorb mechanism was replaced by native Flue joining. The design below is retained for its historical rationale.

**Historical status**: approved and implemented on the earlier runtime; superseded by native Flue joining.

## Problem

Humans type in bursts. Today every engaged message becomes its own Flue dispatch: a 3-message
burst means 3 stacking "⏳ On it…" acks and 3 serialized turns, each answering one fragment with
a backscroll snapshot frozen at *dispatch* time — so turn N never sees turn N-1's reply. Noisy,
token-wasteful, and occasionally incoherent.

Flue 0.11 offers no fix at the queue: the per-instance FIFO queue has no app-facing inspect/
merge/skip/supersede, `dispatch()` takes no options, and the agent initializer never sees the
dispatched input (no dequeue-time code seam). Steering primitives don't exist. So the design
moves to the seams we own.

## Design

**Target UX**: a burst of N messages → one ⏳ ack → one reply addressing all of them. A message
arriving mid-turn is folded into the answer *before it posts*. No message is ever dropped.

Three seams, all app-layer:

1. **Gateway (event time)** — `.flue/app.ts` Slack handler, after the KV idempotency claim:
   if the conversation has a *fresh active* turn receipt (`slack_turn_activity` status `active`,
   last beat within `TURN_DOA_STALE_MS`), do NOT ack/dispatch. Park the message in
   `pending_messages`, react 👀 on it, log it to the transcript, return 200. Messages with file
   attachments bypass absorb (file authorization is scoped per-turn) and queue normally.

2. **Reply drain (drain-before-post)** — `reply_to_conversation` claims pending rows for the
   conversation before posting. Rows found → the tool does NOT post; it returns the parked
   messages to the model with "revise your reply to address everything". Empty drain → post.
   This is the absorb, and quasi-steer for free: a "wait, stop" lands before the wrong answer posts.

3. **Sweep (safety net)** — the every-2-min reconcile cron dispatches a normal combined turn for
   `pending` rows older than a grace window whose conversation has no fresh active turn (covers:
   message landed after the final drain; turn died holding pending rows). Reuses the dead-turn
   retry rebuild pattern (fresh ack + receipt + thread backscroll).

## Row lifecycle

`pending` (parked at gateway) → `absorbed` (claimed by an in-flight turn's drain) or
`dispatched` (claimed by the sweep). Claimed rows are kept for audit, never re-delivered.
If a turn dies *after* draining, the messages are still in the thread backscroll the reaper's
retry turn fetches — acceptable double-coverage, never silence.

## Accepted trade-offs

- A straggler that misses the drain waits ≤ ~2.5 min for the sweep (rare: the window is the
  gap between final drain and receipt completion).
- A long turn drains only when it tries to reply — mid-turn messages wait for the combined
  answer. That's the feature.
- No debounce on the first message of a burst: instant dispatch stays instant.
- Flue's queue is untouched; messages that DO dispatch keep today's FIFO semantics.

## Out of scope (deliberately)

- Mid-tool-call interruption / true steer — no Flue primitive; corrections land at the reply
  boundary instead. Revisit if Flue ships steering upstream.
- Cooperative stop affordance ("🛑 cancels the turn") — design exists, build when dogfooding
  shows wrong-action anxiety.
