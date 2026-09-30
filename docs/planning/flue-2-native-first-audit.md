# Flue 2 Native-First Audit: what custom code to delete

**Date**: 2026-09-30
**Branch**: `flue-2-spike`
**Rule set by the owner**: stay native Flue. Custom code exists only to fill gaps Flue could not cover. If Flue 2.2.2 covers the need cleanly, delete ours.
**Method**: read the repo (`.flue/`, `src/`, `migrations/`, deploy glue, git history for why each piece was built), read the installed Flue docs and types in `spikes/flue2/node_modules/@flue/runtime/` (`docs/` and `dist/`), then ran real probes in `spikes/flue2/` (local `vite dev`, real model `zai/glm-5.3-flash` for most, one `zai/glm-5.2` turn, a local stall server, no production, no Slack).
**LOC**: counted from line ranges in the files, not whole files, and tests are counted where they test only the deleted code. They are estimates to within roughly 10 percent. "Net" means after adding the small replacement code.

## 1. Verdict

About 1,700 lines of infrastructure can go, and about 900 of them can go in the Flue 2 migration itself, because a probe or the spike already proved Flue does the same job. The big ones are burst-absorb (about 415 net), the stream-journal patch (190), and most of the dead-turn reaper (about 110 now, about 130 more later). Another 800 lines are deletable only after a named trigger (a container canary, a GitHub MCP canary, a real-Slack check, or a quiet month of logs). About 5,800 lines of the custom infrastructure stay, and nearly all of that is product logic or integration that Flue has no feature for: agent-runs with Trigger.dev (3,063 lines alone), reminders, reflection and review sweeps, code-mode, the connection broker, and the Slack receipt UX. I pushed back on the principle in six places where deleting would lose behavior or safety: the silent-hang watchdog, the KV event claim, the epoch reset, the workspace audit ledger, the skills catalog, and the model allowlist (section 2b).

## 2. The table

Ranked by net LOC removed. Evidence: PROVEN = a probe (P-A to P-G, section 2a) or the spike doc proved it. READ = seen in the installed docs or source only. UNKNOWN = neither.

### Delete or replace in the migration (native proven)

| Component | Files | LOC (gross / net) | Gap it filled | Flue 2.2.2 native replacement | Evidence | Verdict | Trigger |
|---|---|---|---|---|---|---|---|
| Burst-absorb | `src/slack/absorb.ts`, `absorb.test.ts`; `.flue/app.ts` 849-879 (gate), 364-425 (sweep), 355-360, 134-138 (drain); migration 0026 | 437 / ~415 | Flue 0.11 had no merge of messages that arrive mid-turn (`docs/planning/burst-absorb.md`) | A message that arrives while busy joins the live response at the next turn boundary, and a queued message is never lost (`docs/guide/durability.md` "Submissions"; `useAgentStart` runs once per delivered message; `useAgentFinish` only settles when no delivery is waiting, `docs/reference/agent-hooks-api.md`) | PROVEN, P-B: two rapid messages gave exactly one reply, with message 2 landing during the first model call and during a slow tool | REPLACE WITH NATIVE. Keep about 15 lines at the gateway: if the conversation has a fresh active receipt, skip the second ack and add the eyes reaction, but still dispatch. Add a DROP migration for `pending_messages` only after the sweep has flushed old rows | none |
| Stream-journal patch | `patches/@flue+runtime+1.0.0-beta.1.patch`, `src/shared/stream-journal.ts`, `.test.ts`, `src/shared/patch-guard.test.ts`, `postinstall` and `patch-package` in `package.json` | 190 / 190 | Beta journal stored `partial.content` per delta, so `SQLITE_TOOBIG` (commit `8bd6ddb`) | The journal no longer writes `partial`; deltas batch per 1 s and chunk over the DO value limit (spike findings Q4) | PROVEN by the spike, Q4, but only with a fake provider (real streaming with thinking not run) | DELETE ON MIGRATION | none. Watch storage: about 33x bytes per streamed byte |
| Stale-turn reaper branch + stream heartbeat | `src/slack/activity.ts` 155-176 (heartbeat), about 35 lines of the 430-559 reaper (stale window), beat wiring at 235-238 and 424-427; matching tests in `activity.test.ts` (heartbeat 576-625, stale reaper 438-469) | 147 / ~110 | No "this turn is dead" signal, so a hung turn left "Working" forever (commits `fdcfc7e`, `9e30dc3`, `7f43ba9`) | `Project.durability = { timeoutMs, maxAttempts }` aborts a hung submission and settles it `failed`; `submission_settled` event is the authoritative end. Crash or deploy mid-turn is auto-resumed by Flue | PROVEN, P-C: a tool that never returns was aborted and settled `failed` (`submission_timeout`) at deadline plus about 14 s; spike "Retry ownership" B1 (crash resume) | REPLACE WITH NATIVE. New code: a `submission_settled` handler (about 35 lines) that edits the receipt to "died" or completes it | none. Pick `timeoutMs` from reaper logs (see pushback 1) |
| Tool logging and reply reminder | `src/agent/observability.ts` (63), one wrapper line in `.flue/agents/project.ts:321` | 63 / ~53 | No tool hook in 1.0, so `wrangler tail` was blind; model sometimes ended in plain text and never called the reply tool | Logging: Workers Traces are built in and carry an `execute_tool` span per call with arguments and results (`docs/guide/observability.md` "Cloudflare"); the `observe()` `tool` event also has `durationMs`. Reminder: `useAgentFinish` inspects `response.toolCalls` and `append`s a signal to send the model back to work | Reminder PROVEN, P-E. Traces READ only. Note `tool_start.args` is empty | REPLACE WITH NATIVE (about 10 lines: one finish hook) | none |
| Z.ai provider registration | `src/agent/providers.ts` (36), warn block in `src/project/bindings.ts` 56-65 | ~46 / ~46 | `registerProvider('zai-coding', ...)` for GLM-5.2 | pi-ai's native `zai` provider (catalog has `glm-5.2`, 1,000,000 window, reasoning true, base `https://api.z.ai/api/coding/paas/v4`, `dist/providers/data/zai.json`). Use the model id `zai/glm-5.2`. Secret must be named `ZAI_API_KEY` | PROVEN, P-G: one real `zai/glm-5.2` turn with valid tool calls and a clean stream; glm-5.3-flash in P-A to P-F. Thinking-heavy prompts not tried | DELETE ON MIGRATION (rename the secret from `ZAI_CODING_API_KEY`) | none. Do not make glm-5.2 default until a canary channel runs |
| Wall-clock race | `src/shared/wall-clock.ts`, `wall-clock.test.ts`; call sites in `workspace.ts` (3), `slack-files.ts` (3), `code-mode.ts` (1) | 54 / ~50 | A deploy kills the container or dynamic worker mid-RPC and the await hangs forever (commit `55f49bb`) | `defineTool({ timeoutMs })` aborts the call and returns `ToolTimeoutError` to the model, conversation continues. Native `cloudflareSandbox` also races container death (`raceContainerDeath`, `dist/cloudflare/index.mjs:51`) | `timeoutMs` PROVEN, P-C: bounded tool settled at 10.07 s, turn completed. Container-death race READ only | REPLACE WITH NATIVE (set `timeoutMs` on the 7 tools) | none |
| Cron loopback and token routes | `.flue/cloudflare.ts` (`callInternal`, env types), `.flue/app.ts` `requireHeartbeat` and 5 guards, `/__heartbeat`, `sched:` KV claim | ~50 / ~40 | Cron had to call routes over in-process HTTP with a shared token | `dispatch(Project, {...})` straight from `scheduled()` (`docs/guide/schedules.md`); `idempotencyKey = fireId` replaces the `sched:` KV claim | dispatch key PROVEN, P-A. `scheduled()` to `app.fetch` to `dispatch` PROVEN in spike findings, Extras (b). Direct dispatch in `scheduled()` READ | REPLACE WITH NATIVE. Keep the manual token route only if you want a manual trigger | none |

**Delete-now total: about 990 gross, about 905 net.**

### Deferred: replace only after a trigger

| Component | Files | LOC (gross / net) | Gap it filled | Flue 2.2.2 native replacement | Evidence | Verdict | Deletion trigger |
|---|---|---|---|---|---|---|---|
| Workspace exec, read, write wrappers | `src/workspace/workspace.ts` (about 260 of 401), tests (about 150) | ~410 / ~350 | 0.11's native sandbox booted the container every turn (`docs/planning/flue-011-upgrade.md` Phase 3, rejected) | `useSandbox(cloudflareSandbox(getSandbox(env.SANDBOX, id)))` attached conditionally. Gives `bash`, `read`, `write`, `edit`, `grep`, `glob` | PROVEN, P-D, with a recording fake: unconditional attach calls `createSandbox` plus 3 `exists` plus 1 `readdir` on every submission, even no-tool turns; attached behind a persistent flag, zero calls until a tool flips the flag, then the sandbox and `bash` appear in the same response. Real container NOT run. The real adapter's `exists` and `readdir` are container RPCs (READ, `dist/cloudflare/index.mjs:117-123`) | DEFER WITH TRIGGER. Native lacks the `coordinator_workspace_ops` audit and `redactSecrets` | (1) observer writes the audit row from `tool` events for bash, write, edit (the event carries `details.command` and `exitCode`, P-D), (2) redaction in place, (3) one Docker canary shows no container start on text-only turns and a clean turn with a file. Keep `workspace_load_slack_file` and `workspace_send_file` (Slack side, product) |
| First-strike DOA watchdog and retry | `src/slack/activity.ts` DOA window and retry branch (about 95), `.flue/app.ts` 454-508 and reap wiring 346-354 (64), DOA tests (about 105) | ~265 / ~130 | Provider stream that never starts: detect in 3 min, retry once (commit `6a0bd3b`) | `durability.timeoutMs` ends it, but only at the total deadline, and it is terminal (no retry). Native stream idle timeout exists only for the Workers AI binding provider (`docs/reference/provider-api.md:92`; `dist/cloudflare/workers-ai-provider.mjs:161`) | PROVEN the native gap: P-C stall test, a model that accepts the request and sends nothing ran until the deadline (+60 s for `timeoutMs` 45 s), no early detection, no retry | DEFER WITH TRIGGER. Keep a slim first-token check (about 45 lines): no `message_start` within 3 min of `submission_running` means abort, edit receipt. Drop the model-facing retry unless logs show it fires | Delete the watchdog when model calls go through a provider with `streamIdleTimeoutMs` (Cloudflare AI Gateway binding), or after 4 weeks with zero reaper DOA hits. Delete only the auto-retry if first-strike retries are under about 3 a month |
| GitHub typed read tools | `src/providers/github.ts` (206), related tests (about 60) | ~266 / ~230 | ADR 0003 deferred the GitHub remote MCP pending an MCP-lifetime spike | `useMcpConnection({ name, url, auth: () => token, tools: [allowlist] })`; auth function runs per request, so the Nango token broker stays (`docs/guide/mcp.md`). Connection lives as long as the instance | READ only. Nothing run against a real MCP server | DEFER WITH TRIGGER. The generic `<provider>_call_api` tools and their method fence stay (no MCP for arbitrary Nango providers) | One canary: GitHub MCP with an allowlist of about 6 tools, token from the broker, connect latency under 1 s, survives a DO eviction, and `tool_calls` audit rows still written from the `mcp__github__*` tool events |
| Slack request verification | `src/slack/verify.ts` (42), `slackUrlVerification` and envelope parse in `events.ts` (about 25) | ~67 / ~40 | Hand-written HMAC and URL challenge | `@flue/slack` `createSlackChannel` (verified ingress, URL verification, events, commands, interactions) (`docs/guide/channels.md`, `docs/ecosystem/channels/slack.md`) | READ only. The package is not installed, so its source and replay window are unread | DEFER WITH TRIGGER. Needs Slack app Request URLs changed to `/channels/slack/*` | Read the package source (raw-body HMAC, replay window, retry headers), then one test workspace. Low value per line. Do last |
| Skills read path | `loadSkillCatalog`, `loadActiveSkillBody`, `load_skill` tool in `src/skills/repository.ts` (about 80), catalog block in `src/agent/prompt.ts` | ~80 / ~50 | No native skills in 0.11 | `defineSkill` plus `useSkill` (catalog line in the prompt, `activate_skill` tool) | READ only | DEFER WITH TRIGGER. Bodies must be in the synchronous render (initialData or state), up to 24 KB each per thread; Flue names allow single hyphens only but `SKILL_NAME` in `repository.ts` allows `a--b`; global and project shadowing makes duplicate names | Skill bodies under about 4 KB total per project, or Flue adds lazy skill bodies. Fix the name regex and dedupe first either way. D1 storage and the save, archive, restore tools stay regardless |

**Deferred total: about 1,090 gross, about 800 net.**

### Kept: Flue cannot do it, or it is product logic

| Component | Files | LOC | Native check | Evidence | Verdict, why |
|---|---|---|---|---|---|
| Epoch reset (scope suffix, admin reset route, `agent_epoch`) | `conversations.ts` 61-99, `.flue/app.ts` 544-557, `bindings.ts` generation token | ~60 | No delete or reset API for a conversation (`docs/sdk/overview.md:44`). Hard failures settle in about 1 ms with no retry (spike Retry ownership, D1 and D4) | READ; P-F shows a mid-stream kill did not poison the next turn (one run, fake model) | KEEP as a permanent thin gap. Drive any auto-reset from consecutive failed `submission_settled`, not reaper counting. See pushback 2 |
| KV event-id claim | `src/shared/idempotency.ts` (30), 3 call sites | 30 | Native `idempotencyKey` dedupes the dispatch only | PROVEN for the key, P-A | KEEP for engaged path and ambient path (pushback 3). Only the `sched:` claim moves |
| Reminders table, scan, cron parser, set/list/cancel tools | `src/gateway/reminders-store.ts`, `cron.ts`, `src/agent/reminders.ts` and tests | ~530 | Flue has no scheduler (`docs/guide/schedules.md` first paragraph). Agents SDK `schedule()` is per conversation and cannot list across projects | READ | KEEP. Permanent gap plus product feature |
| Reflect-sweep, review-sweep, overhearing | `src/knowledge/reflection.ts`, `src/review.ts`, `.flue/app.ts` sweeps | ~570 | Gates are SQL over the D1 transcript | n/a | KEEP, product logic. Only the dispatch line changes to a signal |
| Agent-runs outbox, reconcile, callbacks for Trigger.dev | `src/agent-runs/*` | 3,063 (tests 3,482) | Not a durable-workflow filler. It is an integration outbox to an external runner. Flue 2 says outside orchestration uses your platform's workflow engine (`docs/guide/durability.md` "Code outside the agent") | READ | KEEP. A Cloudflare Workflows port is a separate decision, not a Flue feature |
| Code-mode (Dynamic Workers) | `src/code-mode/*` | 491 (tests 337) | Flue has no dynamic-worker code tool. Closest is the virtual bash sandbox, which has no Python or JS runtime | READ | KEEP. Swap `withWallClock` for `timeoutMs` |
| Connection broker, generic `<provider>_call_api`, Nango, audit table | `generic-api.ts`, `nango.ts`, `connections/*` | ~1,100 | MCP covers some providers only | READ | KEEP (product and security policy) |
| Slack receipts, ack, dispatch fallback | `activity.ts` receipts (about 330), `ack.ts`, `dispatch.ts` | ~490 | Flue has no chat UX | n/a | KEEP (product UX). `dispatchSlackTurnWithFallback` still covers admission failure |
| `VALIDATED_MODELS` and `assertValidModel` | `bindings.ts` 29-55, 70-83 | ~40 | Native catalog supplies windows; nothing native records "ran a live turn" | READ | KEEP (behavioral policy, pushback 6) |
| Transcript table `messages`, conversation targets, search | `knowledge/*`, `project/conversations.ts` | ~600 | Flue history covers only dispatched conversations, not ambient messages or cross-thread search | READ | KEEP |

**Kept infrastructure: about 5,800 source lines.**

### 2a. Probe evidence

All in `spikes/flue2/`, agents in `src/agents/probe.ts`, scripts `scripts/pr.mjs`, `plog.mjs`, `stall-server.mjs`. Local miniflare, one run per cell, about 60 short model calls in total. The dev server doubled some events after hot reload, which I ignored.

| Probe | Question | Result |
|---|---|---|
| P-A | Is native `idempotencyKey` atomic when Slack retries before our ack? | Three same-key dispatches fired at once returned one submission id (`sub_ik_<hash>`, derived from the key), two marked `deduplicated: true`, one run. A repeat after the turn settled was deduped. Same key with a different payload is rejected ("already names a different submission"). The same key on another instance is an independent submission. Key retention past one conversation is UNKNOWN |
| P-B | Does a message that arrives mid-turn join, and does the agent reply once? | Real model. Message 2 during the first model call: 1 reply covering both. During a 10 s tool: 1 reply covering both. Edge E1: message 2 after the reply tool already posted: 2 replies, each answering its own question (no duplicate answer, but two posts). Edge E2, a variant that stashes the reply and posts at `useAgentFinish`: one post, but the stash was overwritten so it answered only question 2. It must append, so the variant is NOT proven |
| P-C | Does `durability.timeoutMs` or an idle timeout catch hangs? | A tool that never returns, no tool timeout, `timeoutMs` 45 s: aborted and settled `failed` (`submission_timeout`) at +59.4 s. The deadline fires on the wake cadence, about 14 s late locally; production cadence not measured. The tool got "could not be confirmed cancelled". Same tool with `timeoutMs` 10 s: error to the model at +10.07 s, turn continued and completed. A local model server that accepts the request and never sends a byte: no idle detection, aborted only at the deadline (+60.0 s), settled `failed`, no retry |
| P-D | Does native sandbox boot per turn? | See the workspace row. Unconditional attach initializes on every submission; conditional attach is lazy |
| P-E | Does `useAgentFinish` replace the reply reminder? | The model answered in plain text, the hook saw no `sign_off` call, appended a signal, the model then called the tool, hook re-ran, settled. First attempts with a real `post_reply` tool did not exercise it because glm-5.3-flash called the tool unprompted. The mechanism works; failure-mode frequency is not measured |
| P-F | After a mid-stream crash, does the next turn work (the old wedge)? | Killed workerd while a fake model streamed. On restart Flue ran attempt 2 and completed. A new message afterward ran as attempt 1 and completed in 60 ms. No wedge, one run, fake model |
| P-G | Does native `zai/glm-5.2` work? | One real turn, valid tool calls, clean stop. Catalog window 1,000,000 |

### 2b. Where I pushed back on the principle

1. **The silent-hang watchdog stays, slimmed.** Flue ends a hung turn only at the total wall-clock deadline, and only with a failure (P-C). Its real idle timeout exists only for the Workers AI binding provider, not for our OpenRouter or Z.ai calls. `timeoutMs` is a total budget, not a liveness check, so a value long enough for legitimate long turns makes a silent hang wait that long. Today a silent pre-token hang is caught in 3 minutes. Decide `timeoutMs` from reaper logs, and keep the first-token check until the trigger in the table.
2. **The epoch reset stays.** Flue has no conversation delete and a thread whose every call fails instantly is not retried. P-F suggests 2.x no longer poisons after a crash, so delete the automatic wedge counter after a quiet month, but keep the admin route and the epoch suffix.
3. **The KV event claim stays.** The claim at `.flue/app.ts:845` guards more than dispatch: the working ack post, the receipt, the transcript log. A native key dedupes only the dispatch, so a Slack retry would double-post "On it". The ambient path (`:787`) never dispatches at all. Only the `sched:` claim moves to a native key.
4. **Native skills, not yet.** See the skills row: bodies in state, hyphen rule, duplicate names.
5. **Native sandbox only behind a flag, and not before the audit exists.** Always-on attach boots the container on every turn (P-D). Native tools drop `coordinator_workspace_ops` and the secret redaction, which the ADR treats as a safety requirement.
6. **`VALIDATED_MODELS` is policy, not a workaround.** It records which models survived a real turn (the kimi and deepseek dead-on-arrival history). Only the window-warning half is obsolete. Native `Unknown model ID` fails in about 30 ms (spike Retry ownership, D1), but the reason is only in server logs, so keep the write-time guard.

Also flagged, not assumed: the 6-hour heartbeat fan-out (`fireHeartbeat`, `0 */6 * * *`) wakes every project with no work. Reminders fire from their own minutely scan. It may be dead weight, but that is a product question for you.

## 3. New native features worth adopting (each removes code or risk)

1. `useAgentFinish` with `response.toolCalls`: replaces `withReplyReminder` with a hard check (P-E). Bounded at 32 continuations.
2. `useDelivery()` and `useInitialData()`: bind `conversationId`, the ack timestamp and the reply target in trusted code. The model stops echoing ids, which removes two tool parameters and the `[Dispatch Input]` prompt text. It also closes a hole: today the model picks which `conversationId` to post to.
3. `idempotencyKey` on every dispatch (P-A): Slack `event_id` on turns, `fireId` on scheduled fires, `retry:<id>` on any re-dispatch.
4. Dispatch-only agents (no `createAgentRouter` mount): the public `/agents/project/:id` routes, including abort, disappear. Use `init(Project, { id }).abort()` from code (READ, not run).
5. Workers Traces built in (`docs/guide/observability.md`): tool arguments and results per call, no code. Replaces `withToolLogging`.
6. `defineTool({ timeoutMs })` (P-C): replaces `withWallClock`.
7. Conditional `useSandbox()` (P-D): the lazy path that `flue-011-upgrade.md` listed as its re-entry condition.
8. `useMcpConnection` with `auth: () => token` and a `tools` allowlist: the path for GitHub, and for Linear and Notion if wanted.
9. Native `zai` provider (P-G), including `glm-5.2`.
10. `Project.durability = { maxAttempts, timeoutMs }`: one static replaces the reaper's stale window.

## 4. Migration order (delete as you go)

Phases are commits on `flue-2-spike`. There is one cutover deploy after phase 3. Phase 5 items ship later, each behind its trigger.

| Phase | What happens | Delete in this phase |
|---|---|---|
| 0. Build and pins | Flue 2.2.2, Vite build, plain `wrangler deploy`, `@flue/vite`, pin `pi-ai` 0.87.1 | `patches/`, `stream-journal.ts` and both tests, `postinstall`, `patch-package`, `agents`, `@flue/sdk`, `@flue/cli`. `deploy.yml` and `setup.sh` (which patches `dist/hatchery/wrangler.json`) move to the new output. About 190 lines |
| 1. Tools | Valibot schemas and `run({data})`, `timeoutMs` on the 7 bounded tools, secret `ZAI_API_KEY` | `wall-clock.ts` and test, `providers.ts`, model-window warning. About 100 lines |
| 2. Agent and dispatch | Agent function, `loadAgentContext` seeding, signals with `idempotencyKey`, `useDelivery` for ids, `useAgentFinish` reply check, dispatch-only (no router mount), direct `dispatch` from `scheduled()` | `observability.ts`, burst-absorb (gateway gate, sweep, drain, `absorb.ts`, tests), `callInternal` and token guards, `sched:` KV claim, model-echoed `conversationId` and `ackMessageTs`. About 510 lines |
| 3. Reaper shrink | `Project.durability = { timeoutMs, maxAttempts: 3 }` from reaper logs, `submission_settled` handler edits the receipt, slim first-token check kept | Stream heartbeat, stale-window reaper branch. About 110 lines. The watchdog (130) waits for its trigger |
| 4. Cutover | Two-tag DO reset (`flue-2a-reset`, `flue-2b-recreate`) under the unchanged `Project` name, drained deploy, real-model canary on one channel. Test the migration on a throwaway Worker first (still unproven on Cloudflare) | Add migration 0029 to `DROP TABLE pending_messages`, after confirming no `pending` rows remain (run the old sweep once before the cutover, or drain manually). Never edit an applied migration |
| 5. After cutover, each behind its trigger | Conditional native sandbox, GitHub MCP, `@flue/slack`, native skills, delete DOA watchdog | About 800 lines as the triggers clear |

**What this does to DO state and the cutover:**

- Every conversation DO resets once, cold-starting open threads. The D1 `messages` transcript and receipts survive, and the KV `evt:` keys survive, so a Slack retry around the cutover still dedupes.
- In-flight `slack_turn_activity` rows at the cutover are `active`; the new settle handler and the slim watchdog must be live in the same deploy so they are reaped.
- `usePersistentState` now holds per-conversation state (D1 context snapshot, sandbox flag). It resets with the DO.
- `FLUE_SESSION_GENERATION` and the `@gN` suffix become redundant after the two-tag reset, but they cost 6 lines and are the documented fallback if the reset migration fails. Keep them.
- The `durability` static and the `Project` class name live in code and config, not in state.

## 5. Still unproven, and next probes

| Gap | Why it matters | Next probe |
|---|---|---|
| Production alarm cadence for deadlines and crash recovery | P-C and the spike measured local only (about 14 s late). Sets `timeoutMs` slack | Deploy the probe agents to a throwaway Worker; log deadline-to-settle |
| Real container behavior with native sandbox | P-D used a fake. Does `exists` boot the container on a real `getSandbox`? Does the conditional flag persist across submissions? | Docker canary with `cloudflareSandbox` and a counted container start |
| `idempotencyKey` retention window | KV TTL is 3 h today. Flue's retention is undocumented | Re-dispatch the same key after hours and after DO reset |
| Burst edge: message after the reply tool posted | E1 gives two posts; E2 needs an append-not-overwrite design to give one | Finish-post variant that concatenates, then re-run E1 and E2 |
| `useAgentFinish` failure-mode rate | Did not observe the model skipping the reply tool | Replay past "no reply" turns with the hook on |
| GitHub MCP in a DO | Connect latency, eviction, token rotation, tool-count context cost | The MCP canary in the trigger column |
| `@flue/slack` source | Replay window, retry headers, raw-body handling, our `event_id` dedupe | `npm pack @flue/slack` and read it |
| `init().abort()` from code, and the abort route protection | Needed once the router mount goes | Call it from a cron handler against a running turn |
| Real streaming with thinking and real OpenRouter | Journal size, glm-5.2 dead-on-arrival history | 10 canary turns on one channel after the cutover |
| Reset migration on Cloudflare | Delete and recreate one class in one deploy | Throwaway Worker, as the spike already recommends |
