# Flue 2.2.2 Spike Findings (2026-09-30)

**Historical reference:** This document describes an earlier runtime or experiment. Current production uses Flue 2.2.2; see the [completed cutover](../operations/2026-10-05-flue-cutover.md) and [deployment runbook](../deployment.md). Earlier reset, replay and deployment proposals are not current operating instructions. Unimplemented follow-up ideas remain proposals.

**Verdict: viable, with a rebuild of the agent initializer and a rewrite of every tool's schema.** Nothing found blocks the upgrade. The stream-journal patch is no longer needed, `observe()` survives with a small rename, and we do not use the built-in tools. Two items are bigger than the plan says. First, the agent cannot load D1 before its first model call. D1 data needed on turn one has to come from the dispatcher. Second, all 23 tool files (232 `Type.*` sites) must move from TypeBox `parameters`/`execute` to Valibot `input`/`run({data})`. 2.x throws on the old shape.

Spike project: `spikes/flue2/` (own `package.json`, `@flue/runtime` and `@flue/vite` 2.2.2, vite 8.3, `@cloudflare/vite-plugin` 1.62, wrangler 4.144, pi-ai pinned to 0.87.1 to match the runtime's copy). Everything ran locally under `vite dev` (miniflare, local D1, scripted fake models). No real model, Slack, D1 or Cloudflare account was touched. Helper scripts are in `spikes/flue2/scripts/`.

## Q1. Async D1 loads

**Verdict:** there is no async agent initializer. The working pattern is a hybrid: the gateway passes turn-one data, and an async `useAgentStart` seam plus `usePersistentState` keeps later turns fresh. Plain `useAgentStart` alone lags by one delivery.

Mechanism (in `spikes/flue2/src/agents/project.ts`):

```ts
const [loaded, setLoaded] = usePersistentState<Loaded | null>('d1ctx', null);
const delivery = useDelivery();
const initial = useInitialData<{ model?: string; d1?: Loaded } | undefined>();
const ctx = loaded ?? initial?.d1 ?? null;
useModel(delivery.attributes?.model ?? initial?.model ?? ctx?.model ?? DEFAULT);
useAgentStart(async ({ log, append }) => { const fresh = await loadFromD1(projectId); setLoaded(fresh); });
```

Evidence (all run; the system prompt is read from `turn_request.request.input.systemPrompt` in the observer):

| Test | Result |
|---|---|
| New instance, D1 has persona, start seam loads it | Turn 1 prompt says `No persona loaded.` The seam's log line appears before `turn_request`, yet the first render used no state. The initial render runs before the seam. |
| Second delivery, same instance | Prompt has `You are Pip the helper.` and the memory block. |
| Mutate D1 (persona, memory, model), deliver again | First turn still shows the OLD persona, memory and model (`model-a`). The next delivery shows the new values and `model-b`. One-delivery lag. |
| Tool calls `setLoaded(prev => ...)` (save_memory), then the model's second call in the same submission | Second `turn_request` includes `- saved-by-tool`. Setters work from tool `run`, and renders before calls 2+ see them. |
| New instance created with `initialData: { d1: {...} }` | Turn 1 prompt has the seeded persona and memory. A second delivery with different `initialData` is ignored (instance exists). After the start seam ran once, `loaded` takes over. |
| `useModel(delivery.attributes.model)` on a new instance | First submission uses `model-b`. `initialData.model` also works. Durable state from the same delivery's seam does not (first submission used `model-a`). |
| `ctx.append({kind:'signal', ...})` in the start seam | The model sees `<signal type="project.context">persona=...; memory=...</signal>` before turn 1, while the system prompt stays stale. Works, but the body is persisted each delivery. |

Source explains it: `runAgentStartHooks` runs after the initial render and only re-renders for joined deliveries (`conversation-stream-store-2-jUriih.mjs:1610-1624`).

**Author visibility is solved.** `useDelivery()` returns the dispatched message including signal `attributes`. A tool closure reading it returned `{sender:'dave', conversationId:'1111.0004'}` with no model echo. The "`ctx.payload` undefined on dispatch" limitation is gone. `conversationId` and `ackMessageTs` no longer need to be model-facing tool parameters. Per-author memory injection becomes possible.

**Costs and caveats:**
- D1 reads happen once per delivery (the seam), not per render. Renders are pure reads of persisted state. State writes are no-ops when deep-equal.
- Every new Slack thread is a new instance (`conv:<id>@gN`), so turn one of most threads has empty state. It must be seeded through `initialData` (persona, skill catalog, memory, connections, model) by one shared `loadAgentContext(db, projectId)` called at each dispatch site. That is the real rebuild.
- Changing the composed instructions between renders makes the runtime inject a `<signal type="instructions">System instructions updated.</signal>` user message. I saw this in the transcript. The system prompt changes too. Do not put per-message facts (sender) in `useInstruction`. The spike did, deliberately; real code should use tools or signals instead. This was read in the transcript, and I did not measure prompt-cache impact.
- A module-scope cache filled in the seam would be fragile: on resume after assistant steps exist, or when an `agent_start_run` marker exists, the seam is skipped wholesale (`:1610-1612`). Persistent state survives eviction. A module cache does not. (Read from source, not run.)
- Tools can still close over `env.DB` (`import { env } from 'cloudflare:workers'` works inside tools and seams, tested). Binding-dependent tools can self-gate and read D1 inside `run` rather than depend on render-time data.
- The `useModel` value is read once per submission, before the seam. Per-project model from D1 must arrive by delivery attribute or `initialData`.

## Q2. `observe()` and stream beats

**Verdict:** `observe(subscriber)` still exists with the same call shape. Every event `activity.ts` reads still exists. Two behavior changes need code.

Subscriber: `observe((event, ctx) => ...)`. `ctx` is `FlueEventContext` with `id`, `agentName`, `env`, `req`, `log`. `FlueContext` is not exported in 2.2.2 and the import in `activity.ts` must become `FlueEventContext`. `ctx.env.DB` works inside a DO-isolate observer (the spike's observer wrote every event to D1). `event.instanceId` is exactly the dispatched id (`project:P2:agent:default/conv:FAST100@g1`), so `parseAgentInstanceId` keeps working. Top-level `observe()` in `app.ts` runs in each isolate, because `app.ts` is evaluated in each DO.

| `activity.ts` reads (1.0) | 2.2.2 | Change |
|---|---|---|
| `event.instanceId` | same, on every event | none |
| `tool_start` `{toolName}` | same. `args` is not populated | none |
| `tool` `{toolName, isError}` | same, plus `durationMs`. Published when the tool batch commits, not at finish | none |
| `message_start` | fires for `user`, `assistant` and `toolResult` messages (seen in captured events) | **add `event.message.role === 'assistant'`**. Otherwise "Receiving stream response" posts on every tool result. |
| `text_delta` `{text}` | same, but published only after the ~1s canonical flush | cadence below |
| `thinking_delta` `{delta}` | same, same flush | cadence below |
| (new) `toolcall_delta` | live, not persisted, emitted at 0ms | optional extra beat for long tool-argument generation |
| (new) `submission_settled {outcome, error}` | terminal state of every submission | authoritative completion, could replace heartbeat inference |
| (new) `submission_recovery`, `submission_running {attemptCount}` | recovery re-emits | see "surprises" |
| `run_start` / `run_end` (not read by us) | `agent_start` / `agent_end`, plus `submission_queued`, `submission_running`, `submission_settled`, `idle`, `operation*`, `turn*` | none |

Captured cadence with a 60 tok/s fake model (`spikes/flue2/scripts/events.mjs`): `text_delta` rows arrive about every 1.0 to 1.1 s (for example +2633, +3653, +4687, +5711 ms), each carrying about 15 deltas. `thinking_delta` behaves the same. Stream beats come roughly 1 per second, well inside the existing 5 s `STREAM_HEARTBEAT_MS` throttle. There is no per-chunk beat. A beat equals one flushed batch, which is enough for the reaper.

Dev caveat: in `vite dev`, hot reload re-evaluates `app.ts` and stacks observers (events were recorded 2x to 4x after edits). Production evaluates once per isolate. Guard with `globalThis` if it matters in dev.

## Q3. Built-in tools

**Verdict: we do not rely on them.** Grep of `.flue/`, `src/`, `seeds/`, `agent-kits/` (word-boundary, excluding tests) found no `bash`/`read`/`write`/`edit`/`grep`/`glob` tool references other than prompts and descriptions that say the agent has NO bash (`src/agent/prompt.ts:85`, `src/agent/self.ts:99,100,135`, `src/code-mode/code-mode.ts:317`) and one `bash -c` hint in the workspace tool's own parameter text (`src/workspace/workspace.ts:251`). `withReplyReminder` filters only on our `DELIVERY_TOOLS` names. No `session.*`, `harness`, `createBashTool` or `sandbox:` config. The workspace tools use our own `SandboxFactory` type (`workspace.ts:25`), not Flue's. Nothing to add. Unverified: skill bodies stored in production D1 could tell the model to use built-in tools. I did not read them.

## Q4. Stream-journal patch

**Verdict: patch not needed, drop it.** `StreamChunkWriter` and `partial` journaling are gone from 2.2.2.

- Design: `ConversationRecordWriter` (`sql-agent-execution-store-C0vwyWZB.mjs:13`) coalesces deltas for `CANONICAL_FLUSH_DELAY_MS = 1000`. Each `message_update` becomes a record carrying only `delta`, never `partial` (`conversation-stream-store-2-jUriih.mjs:2282-2290`). Size is linear in deltas, not deltas x message length. Batches over the DO value limit are chunked into `flue_conversation_stream_batch_chunks`. There is a 12 MB per-append ceiling (`MAX_BATCH_DATA_LENGTH`), with an explicit error.
- Measured (local DO SQLite, `scripts/journal.mjs`):

| Run | Result |
|---|---|
| 500 KB in one response at ~1250 deltas/s (47 s) | 55 batches, largest batch 424 KB, total 16.6 MB stored, `partial` never present |
| 100 KB burst in a single flush (6,250 deltas) | one 3.3 MB batch stored as 7 chunk rows of at most 512 KB. No `SQLITE_TOOBIG`. |
| 500 KB burst in a single flush (31k deltas) | batch serialized to 15.8 MB, over the 12 MB ceiling. The submission failed once, went to `submission_recovery`, retried about 30 s later. |

The last case needs about 24k deltas inside one second, far beyond any real provider. A record costs about 500 bytes of envelope per delta, so stored size is about 33x the text (500 KB becomes 16 MB). That is a storage cost to watch, not a crash. Re-port: none. Delete `patches/@flue+runtime+1.0.0-beta.1.patch`, `src/shared/stream-journal.ts` and its test, and `patch-package` if nothing else uses it. I only ran a fake provider. A real provider with thinking/tool-call streaming was not run.

## Q5. DO migrations and cutover

**Verdict:** class and binding are unchanged for an agent function named `Project`, plus one added migration. Both the `migrations` array and the declarative `exports` form pass build and dry-run.

- `vite build` merged config (`dist/<name>/wrangler.json`): `durable_objects.bindings = [{name:"FLUE_PROJECT_AGENT", class_name:"FlueProjectAgent"}]`. No `FlueRegistry` binding. The built entry exports `FlueProjectAgent`, `Sandbox` and a default with `fetch` and `scheduled`. The agent stays named `Project`. (An `agentName` rename would change the class and binding; we are not doing that.)
- Our 5-tag history (`flue-class-FlueRegistry`, `flue-class-Project`, `sandbox-class`, `flue-011`, plus new `{tag:"flue-2", deleted_classes:["FlueRegistry"]}`) is passed through verbatim. `npx wrangler deploy --dry-run` (no `--config`) accepted it and used the redirect `.wrangler/deploy/config.json`. Flue does not read or validate migrations. Its only runtime check is that the class has SQLite storage.
- Declarative `exports`: wrangler's schema says DO `exports` are mutually exclusive with `migrations`. I built with `exports: {FlueProjectAgent: created/sqlite, Sandbox: created/sqlite, FlueRegistry: deleted}` and no `migrations` (`wrangler.exports-variant.jsonc`). Flue built fine, the merged config kept `exports` and emitted `migrations: []`, and `--dry-run` passed. So they coexist at the config layer. Not proven: Cloudflare accepting a switch from migration history to `exports` on the live Worker. Keep `migrations` for the cutover.
- Stale-data trap and the reset (corrected; the earlier `project-v2` rename idea is withdrawn): existing `FlueProjectAgent` DOs hold beta-format data, and 2.x rejects it (`PersistedFormatVersionError`, per the guide, not reproduced). Keep the name `Project` and reset storage with a two-tag migration that replaces the `flue-2` tag above:
  ```jsonc
  { "tag": "flue-2a-reset",    "deleted_classes": ["FlueProjectAgent", "FlueRegistry"] },
  { "tag": "flue-2b-recreate", "new_sqlite_classes": ["FlueProjectAgent"] }
  ```
  Proven: `vite build` and `npx wrangler deploy --dry-run` both accept this history, the merged config still has `FLUE_PROJECT_AGENT` / `FlueProjectAgent`, and the class stays exported. NOT proven: that Cloudflare accepts delete-then-recreate of one class name in a single deploy, or that it wipes the storage. Dry-run validates config only, and miniflare does not execute migrations. Whether it needs two separate deploys (2a, then 2b) is unknown. Safe fallback: ship 2a alone (the Worker must then stop exporting `FlueProjectAgent`, which means a build without the agent), then 2b. Test this on a throwaway Worker before cutover. Both need a drained deploy. FlueRegistry must be deleted exactly once in the whole history.
  Fallback if the reset cannot be made to work: bump `FLUE_SESSION_GENERATION` from 1 to 2 in `src/project/bindings.ts:106`. Every dispatch site builds its id through `agentInstanceId`, so all families get fresh `@g2` ids in one line. Old DOs become orphans that cost storage. Risk: an orphan with a pending alarm could wake into 2.x code on beta-format storage (not tested).
- No `.flue-vite.wrangler.jsonc` was produced with `@flue/vite` 2.2.2 and plugin 1.62.2. The finalized config is `dist/<worker-name>/wrangler.json`. The guide's gitignore advice is harmless.

## Extras

**(a) Dispatch call sites.** `dispatch(Project, {id, message, initialData?, idempotencyKey?, uid?})`. `idempotencyKey` is in `AgentDispatchRequest` (types `types-B1PuLhZt.d.mts:322`; the reference doc omits it). Tested: same key twice returned the same `submissionId` with `deduplicated: true` and ran one turn. A different payload with the same key rejected ("already names a different submission"). `submission_queued` re-emits on replay. Keys are at most 256 chars and scoped to `(agent, id)`. A Slack `event_id` fits. Keep the KV claim: it also guards the pre-dispatch ack and D1 writes. The key is an extra guard on dispatch retries.

Message kind per site (all run shapes tested; the site mapping is by reading `app.ts`):

| Site | Today (`input`) | 2.x message |
|---|---|---|
| Slack turn (:926), straggler drain (:409), DOA retry (:491) | `{message, conversationId, ackMessageTs, senderId, provider, accountId, threadContext}` | `signal` `slack.message`, `body`=text, `attributes`={senderId, conversationId, ackMessageTs, provider, accountId}. `idempotencyKey` = Slack `event_id`. |
| Heartbeat (:114) | `{kind:'heartbeat', now, topic?}` | `signal` `heartbeat` |
| Scheduled job (:175) | `buildScheduledInput` | `signal` `scheduled`, key = `fireId` |
| Reflect-sweep (:444), review-sweep (:525), overhear (:806) | `{kind:'heartbeat', instructions}` | `signal` with a typed name, `body` = instructions. Fresh ids per call. |
| Work item (`src/workbench/gateway.ts:127`) | `input` record | `signal` |

Nothing needs `kind:'user'`. User kind means a direct 1:1 prompt. A plain string message and `user` kind also dispatch fine (tested). The `[Dispatch Input]` wording in `src/agent/prompt.ts:149` and in tool descriptions must change: signals render as `<signal type=".." sender="..">body</signal>`. Dispatch ids with `:`, `/` and `@` (our real format) are accepted.

**(b) `cloudflare.ts`.** Works unchanged in shape. `export { Sandbox } from '@cloudflare/sandbox'` (0.12.1) built and was exported. The default-export `scheduled()` ran via `/cdn-cgi/handler/scheduled` and called `app.fetch(...)` in-process, which dispatched to the agent. Constraints: file moves to `src/cloudflare.ts`, and the default export must not define `fetch`. The container and real Sandbox calls were not run.

**(c) Tool return shapes.** Not a problem for us: the tools I read (`memory.ts`, `github.ts`, `self.ts`, `status.ts`, `code-mode.ts`, `workspace.ts`, `generic-api.ts`, `workbench/tools.ts`) return strings (`JSON.stringify`, `safeJson`). A bare string is accepted (run: `no_input` returned `"ok-string"`). A bare object throws at runtime as a tool error and also fails `tsc` (run). `{output: {...}}` works. The real break is the schema and field rename below. `withToolLogging` and `withReplyReminder` (`src/agent/observability.ts`) wrap `execute` and must be rewritten to wrap `run` and preserve envelope returns.

## Surprises not in the plan

1. **Every tool file breaks, not just renames.** We use `parameters: Type.Object(...)` and `execute(...)`. 2.2.2 throws `defineTool() received unknown field "parameters"`, and `input must be a Valibot schema` for TypeBox (run: `scripts/legacy-tool-probe.mjs`). That is 23 files, 232 `Type.*` sites, 48 `parameters:` and 52 `execute` sites, plus the two wrappers. Mechanical but wide. A small TypeBox-to-Valibot shim would not pass Flue's `vendor === 'valibot'` check. Plan for a real rewrite, or a converter that emits Valibot schemas (not attempted).
2. **The agent has no async initializer.** D1 data is one delivery stale unless seeded through `initialData` or delivery attributes (Q1). This is the largest design change.
3. **`cloudflare()` alone fails the build** in 2.2.2: `[flue] The Cloudflare plugin is not receiving Flue's Worker configuration`. Use `cloudflare({ config: flueWorkerConfig() })` with `flueWorkerConfig` from `@flue/vite`. The migration guide and our plan omit this.
4. **`message_start` fires for every role** (seen). `activity.ts` needs a role filter.
5. **Durable retry overlaps our reaper.** Tested in the follow-up: see "Retry ownership" below. Flue resumes interrupted submissions on its own. Our re-dispatch either joins the live response or dedupes, so double replies were not reproduced, but the ownership rule still needs to change.
6. **`agents` dependency can be dropped.** `@flue/vite` depends on `agents ^0.20.1`, and no file in `src/` or `.flue/` imports `agents` (grep).
7. **Pin `pi-ai` to the runtime's copy** (0.87.1). `@flue/runtime` declares `^0.87.1`, and a caret on 0.x pins the minor. The latest (0.99.1) would install a second copy next to the runtime's nested one, so our custom provider objects would come from a different module instance. I avoided this by pinning and did not reproduce the failure.
8. **Instruction changes inject an "instructions updated" signal** into the transcript and change the system prompt. Keep the system prompt stable per thread.
9. **Overhead 33x** in journal storage per streamed byte (Q4).
10. The provider API changes (`registerProvider` to `createProvider` + `setProvider`) were not run. The OpenRouter `z-ai/glm-5.1`, `xiaomi/mimo-v2.5-pro` and `deepseek/deepseek-v4-pro` ids are in pi-ai 0.87.1's catalog (grep of the catalog JSON only).

## Still unproven

- Any real model call, including GLM via OpenRouter, thinking models, the Z.ai custom provider port (`createProvider`), and real tool-call streaming.
- Real Slack events, the reaper against real stale rows, and `postSlackActivityReceipt` (only the event stream was captured; `activity.ts` itself was not ported or run).
- Dispatch while busy (join the live response) and our `absorb.ts` overlap. Not run.
- DO eviction and recovery, `submission_recovery` behavior, and what a retry replays. Read only.
- Production deploy: Cloudflare accepting the 5-tag history or the `exports` form, `deleted_classes` of `FlueProjectAgent`/`FlueRegistry` on the live Worker, pending old alarms. `--dry-run` only.
- Container Sandbox, Dynamic Workers, Nango and the other bindings. Only `DB` (used), `SLACK_EVENTS` (declared, never read), the cron handler and the `Sandbox` class export (no container config) were exercised.
- Prompt-cache impact of instruction changes; the CI workflow (`.github/workflows/deploy.yml`) port; `vite build` output size (about 6.5 MB upload in the spike).
- `vite dev` with the `exports` variant (only build and dry-run).

## Recommended order of work

1. Pin packages and build pipeline: `@flue/*` 2.2.2, `vite`, `@flue/vite`, `@cloudflare/vite-plugin`, `valibot`, pi-ai 0.87.1. `vite.config.ts` with `flueWorkerConfig()`. Move `app.ts` and `cloudflare.ts` under `src/`. Update `deploy.yml` to `vite build` and plain `wrangler deploy`. Drop `agents` and the journal patch.
2. Tool rewrite: Valibot `input`, `run({data})`, rewrite `withToolLogging`/`withReplyReminder`. Add `role === 'assistant'` to `activity.ts` and switch to `FlueEventContext`. Both are testable with the existing unit tests.
3. Shared `loadAgentContext(db, projectId)` and the agent function: `initialData` seed, start-seam refresh into `usePersistentState`, model via delivery attribute. Drop the `[Dispatch Input]` wording and model-echoed `conversationId`/`ackMessageTs` in favor of `useDelivery()`.
4. Dispatch sites: `dispatch(Project, {id, message: signal, idempotencyKey})` across all 8 kinds. Keep KV claims.
5. Decide reaper vs durable retry ownership; set `Project.durability`; port beats.
6. Cutover: two-tag reset migration (`flue-2a-reset`, `flue-2b-recreate`) under the unchanged `Project` name, drained deploy, then a real-model canary on one channel. Test the migration on a throwaway Worker first.


## Retry ownership (follow-up spike)

**Recommendation: Flue owns retry of execution. Our reaper becomes a backstop that aborts and reports, and it stops re-dispatching on its own.** Failures are split by kind below. All scenarios ran a real model (`zai/glm-5.3-flash` via pi-ai's native `zai` provider, key from a gitignored `.dev.vars`, about 25 short turns) under `vite dev` with local D1. The test agents are in `spikes/flue2/src/agents/retry.ts` (`Retry` default durability, `RetryOnce` with `durability = { maxAttempts: 1 }`). `slow_step` sleeps 20 s and writes `tool_calls` when it starts. `post_reply` writes `replies`. A kill is `pkill -9` on workerd and vite, then a restart.

### Results

| # | Scenario | Result (all run) |
|---|---|---|
| A | Clean turn | 1 `tool_calls`, 1 `replies`. Events: `submission_queued`, `submission_running {attemptCount:1, maxAttempts:10}`, `tool_start`/`tool` (slow_step 20 s), `agent_end`, `submission_settled completed` at +36 s. |
| B1 | Kill mid-`slow_step`, restart, do nothing, default durability | Flue resumed by itself: `submission_running {attemptCount:2}` about 2 s after the server was back up (local; in production the wake is alarm-driven, about a 30 s backstop per the docs, not measured). **`slow_step` did not re-run (1 row).** The interrupted call was settled with `{"type":"interrupted","message":"Tool execution was interrupted before completion. The outcome is unknown."}` (isError, in the durable record, read from SQLite). No `tool` event was published for it. The model then called `post_reply`: 1 reply, `submission_settled completed`. No `submission_recovery` event on this path. |
| B2 | Same, `maxAttempts: 1` | On restart Flue did not re-run: `submission_settled {outcome:"failed", type:"submission_retry_exhausted", message:"Submission exceeded maximum recovery attempts (1/1)"}`. 1 `tool_calls`, 0 replies. So retry can be turned off with the `durability` static. Oddity: the first `submission_running` still reported `maxAttempts: 10` while settlement used 1. |
| C-a | After a kill as in B, re-dispatch the same text, no key, about 8 s after restart (Flue recovery in flight) | The new message **joined the live response** (`submission_queued` only, no `submission_running` of its own) and both settled together. 1 `tool_calls`, **1 reply**. |
| C-b | Same, same `idempotencyKey` | Receipt had `deduplicated: true` and the original `submissionId`. 1 tool call, **1 reply**. |
| C-c | Same, new key | New submission id, joined the live response. 1 tool call, **1 reply** (the model answered both messages once). |
| C-late | Turn completed, then a re-dispatch (no key) 45 s later | No new tool call or reply (1/1). The model answered without repeating. This is model behavior, not a guarantee. |
| Abort | `POST /agents/retry/<id>/abort` during the model call, and during `slow_step` | Returns `{"aborted":true}`. Settles `submission_settled {outcome:"aborted", type:"submission_aborted"}` within ms. Mid-tool: a `tool` event with `isError` ("The tool execution could not be confirmed cancelled and may still be running"), `agent_end stopReason:"error"`, `operation` error `AbortError`, then settled aborted about 4 s after the call. 0 replies. The abort covers the running turn and everything queued behind it on that instance. `init(Agent,{id}).abort()` exists in code (read, not run). |
| D1 | Bogus model id (`zai/glm-bogus`) | Fails at once: `submission_settled {outcome:"failed", type:"internal_error"}` in 29 ms, then `submission_recovery {operation:"process_submission", outcome:"deferred"}`. No `agent_end`/`operation` events. The real reason ("Unknown model ID") is only in server logs. No retry. |
| D2 | Provider not configured (`openai/...`, no key) | Settled `failed` in 45 ms: `turn isError "Provider is not configured: openai"`, `agent_end stopReason:"error"`, `operation isError`, `submission_settled failed`. No retry. |
| D3 | Fake provider returns `429 Too Many Requests` | Flue retried the turn 4 times inside the operation (t = 0, 1.9, 4.9, 12.1 s), then `submission_settled failed` (`operation_failed`). About 12 s total. |
| D4 | Fake provider returns `400 invalid request` | One attempt, `submission_settled failed` within 1 ms. |

So: a double reply was not reproduced in any timing I tried. A re-dispatch during recovery joins the running response, a keyed retry dedupes, and Flue never re-runs a started tool (it marks it interrupted). Caveats: one run per cell; the join happens only while the instance is busy, and a model might answer a joined duplicate twice; C-late depends on model behavior.

### Who owns what

| Failure kind | Owner | What we do |
|---|---|---|
| Crash, eviction or deploy mid-turn | Flue (auto-resume, tool calls marked unknown-outcome, budget `maxAttempts`) | Nothing. Do not re-dispatch. Keep the receipt active while `submission_running` or beats keep arriving. |
| Transient provider error or silent stream (429, outage; idle timeout) | Flue (in-operation backoff, about 12 s in the 429 test; silent streams retry per the docs, not run) | Nothing. |
| Hard failure (unknown model, provider not configured, 400) | Nobody retries. It fails in milliseconds and repeating it fails again. | Mark the receipt failed at once from `submission_settled`. Show a clear "mention me again" note. Count consecutive failures per conversation for the epoch reset. |
| Retry budget or timeout exhausted (`submission_retry_exhausted`, timeout) | Flue gave up | Same as hard failure. Do not auto-redispatch. |
| A turn we think is dead but Flue has not settled (no beats for the threshold) | Our reaper, as a backstop only | **Abort first**, wait for `submission_settled aborted`, then edit the receipt. A first-strike silent hang may be re-dispatched once, with a keyed `idempotencyKey`. |

The exact rule: our code never calls `dispatch` to retry a turn while the original submission is unsettled. A retry is allowed only after a `submission_settled` of `aborted` (or a failed settle classified as a silent hang), at most once per turn, with `idempotencyKey = "retry:<original event id or ackMessageTs>"`.

### Concrete changes (no edits made in this spike)

- `src/slack/activity.ts:1`: import `FlueEventContext`, not `FlueContext`.
- `src/slack/activity.ts:220-258` (`handleObservedSlackActivity`): add branches for `submission_settled` (failed or aborted: set the row `failed`, bump `doa_count` when no activity was recorded, edit the receipt immediately with `TURN_DIED_TEXT`; completed: call `completeSlackTurnActivity` as a backstop) and `submission_running` (touch `updated_at`; when `attemptCount > 1`, optionally label "Resuming"). Log `submission_recovery` for alerting only.
- `src/slack/activity.ts:414-428` (`observedSlackActivityEvent`): require `event.message.role === 'assistant'` on `message_start`; optionally treat `toolcall_delta` as a beat.
- `src/slack/activity.ts:436-438`: keep the constants as backstop thresholds. Set `Project.durability = { maxAttempts: 3, timeoutMs: 900_000 }` so Flue's own deadline lands before the 10 min stale window is relevant. Pick the real numbers from reaper logs. The 3 min no-beat rule stays only for silent hangs before the first token (whether Flue's idle timeout covers our providers is unproven).
- `src/slack/activity.ts:467-545` (`reapStaleTurnActivities`): before marking a row failed, call abort for the instance and proceed only once aborted. Keep the retry gate at `:518` (first-strike DOA) but pass a keyed retry. Keep the wedge reset at `:538`, now also counted from `submission_settled failed`.
- `.flue/app.ts:348-350`: `retryTurn` wiring stays, but `retrySlackDoaTurn` (`:458-507`) must abort first and dispatch with `idempotencyKey` (the `dispatch` at `:491`) instead of relying on a fresh ack. Alternatively drop it and rely on Flue's in-operation retry plus the user's own re-mention.
- `.flue/app.ts:368-420` (`sweepPendingMessages`, dispatch at `:409`): the parked-message sweep overlaps with Flue's own join-at-turn-boundary. Give its dispatch an `idempotencyKey` built from the claimed row ids, and reconsider `src/slack/absorb.ts` once the join behavior is proven with real Slack bursts.
- Abort surface: expose an internal abort route or call the agent handle's `abort()`. The mounted router already serves `POST /agents/<name>/:id/abort` (protect it: anyone who can reach it can abort).

### Not proven here

Production alarm cadence for recovery (only local restart measured); Flue's silent-stream idle timeout on our OpenRouter and Z.ai providers; behavior when a model answers a joined duplicate twice; `init().abort()` from code; transient-error classification beyond the two fake messages; our `activity.ts` changes themselves (only the event streams were captured).
