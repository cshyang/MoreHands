# Flue 2.2.2 Spike Findings (2026-09-30)

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

- `vite build` merged config (`dist/<name>/wrangler.json`): `durable_objects.bindings = [{name:"FLUE_PROJECT_AGENT", class_name:"FlueProjectAgent"}]`. No `FlueRegistry` binding. The built entry exports `FlueProjectAgent`, `Sandbox` and a default with `fetch` and `scheduled`. Setting `Project.agentName = 'project-v2'` yields `FLUE_PROJECT_V2_AGENT` / `FlueProjectV2Agent` (run). A kebab `agentName` of `project` gives the same pair as `Project`.
- Our 5-tag history (`flue-class-FlueRegistry`, `flue-class-Project`, `sandbox-class`, `flue-011`, plus new `{tag:"flue-2", deleted_classes:["FlueRegistry"]}`) is passed through verbatim. `npx wrangler deploy --dry-run` (no `--config`) accepted it and used the redirect `.wrangler/deploy/config.json`. Flue does not read or validate migrations. Its only runtime check is that the class has SQLite storage.
- Declarative `exports`: wrangler's schema says DO `exports` are mutually exclusive with `migrations`. I built with `exports: {FlueProjectAgent: created/sqlite, Sandbox: created/sqlite, FlueRegistry: deleted}` and no `migrations` (`wrangler.exports-variant.jsonc`). Flue built fine, the merged config kept `exports` and emitted `migrations: []`, and `--dry-run` passed. So they coexist at the config layer. Not proven: Cloudflare accepting a switch from migration history to `exports` on the live Worker. Keep `migrations` for the cutover.
- Stale-data trap: existing `FlueProjectAgent` DOs hold beta-format data, and 2.x rejects it (`PersistedFormatVersionError`, per the guide, not reproduced). Options:
  - A. Keep the class, bump `FLUE_SESSION_GENERATION` from 1 to 2 in `src/project/bindings.ts:106`. Every dispatch site builds its id through `agentInstanceId` (heartbeat, job, conv, reflect, review, overhear, work), so all families move to fresh `@g2` ids in one line. Old DOs become orphans that cost storage.
  - B. New identity (`Project.agentName = 'project-v2'`) with `deleted_classes: ["FlueProjectAgent","FlueRegistry"]`. Deleting wipes old storage and any pending alarms.
  - **Recommend B.** An old DO with a pending alarm would wake into 2.x code on beta-format storage, which is the risk with A. Nothing in our code references `FLUE_PROJECT_AGENT`. Both need a drained deploy. Keep generation at 1 or bump it; B makes it irrelevant.
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
5. **Durable retry can fight our reaper.** 2.x retries interrupted submissions itself (`maxAttempts` default 10, `timeoutMs` default 1 h, `submission_recovery` events). The reaper (10 min stale, 3 min DOA) and the DOA auto-retry in `app.ts` may edit the receipt and re-dispatch while Flue also retries, giving duplicate replies. Decide who owns retry before porting. `submission_settled` and `submission_recovery` are the new ground truth. Set `Project.durability` deliberately. (Read from docs and events, not reproduced.)
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
6. Cutover plan (option B): `agentName` new identity, `deleted_classes: [FlueProjectAgent, FlueRegistry]`, drained deploy, then a real-model canary on one channel.
