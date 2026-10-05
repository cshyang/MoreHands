# Flue 2.x Upgrade and Cloudflare Evolution

**Status update (2026-10-05):** The Flue 2.2.2 production migration is complete; see the [cutover record](../operations/2026-10-05-flue-cutover.md). The baseline and release claims below record the original September research. The proposed Sandbox, snapshot and credential-injection work remains unimplemented research, not an approved execution plan.

**Date**: 2026-09-30
**Status**: research only, nothing built. Tier 1 is finalized after the Flue spike. Tier 2 is revisited after that.
**Baseline**: `@flue/runtime`, `@flue/sdk`, `@flue/cli` at `1.0.0-beta.1`; `@cloudflare/sandbox` `0.12.1`; `agents` `^0.15.0`; `compatibility_date` `2026-06-09`.

## Tier 1: do now

| # | Item | Why now | Open question |
|---|---|---|---|
| 1 | Flue `1.0.0-beta.1` to `2.2.2` | Biggest change. Rebuilds the agent, dispatch, build pipeline and observer. | See the spike below. |
| 2 | Check DO keep-alive (2026-06-19) against reaper logs | Outbound connections now keep a DO alive. May explain some dead-on-arrival turns. Free to check. | Does it need a newer `compatibility_date`? |
| 3 | Sandbox SDK `0.12.1` to `1.0.0` (npm 2026-09-30) | Independent of Flue. Cloudflare deprecated default sessions, `exposePort` and the HTTP/WebSocket transports on 2026-06-09. | 1.0 migration notes not read: https://developers.cloudflare.com/sandbox/1-0-preview/migrate/ |
| 4 | Container snapshots (public beta, 2026-09-30) | Sleep-to-save for the workspace sandbox. | Beta. Depends on item 3. |
| 5 | Outbound Workers credential injection (2026-04-13) | Sandbox tokens stay outside the container. | Do together with item 3 or 4. |

Order: Flue spike (1), reaper-log check (2) in parallel, then read the Sandbox 1.0 notes and decide on 3 to 5.

## Flue 2.x: what changes

2.0.0 shipped 2026-07-31. There was never a stable 1.0 (last beta on npm is `1.0.0-beta.9`). `latest` is `2.2.2` (2026-09-28). 2.1 and 2.2 are additive. Beta databases are rejected with `PersistedFormatVersionError`, with no migration.

Sources: `github.com/withastro/flue` (`CHANGELOG.md`, `packages/runtime/CHANGELOG.md`, `apps/docs/src/content/docs/guide/migration.md`), https://flueframework.com/docs/guide/migration/

| Area | Today | In 2.x | Effort |
|---|---|---|---|
| Build | `flue build --target cloudflare`, `.flue/` root, deploy from `dist/hatchery/wrangler.json` | Vite plugin (`flue()` before `cloudflare()`), plain `wrangler deploy`, `defineConfig` from `@flue/runtime/config`, no `root`/`output` | Rewrite, plus `.github/workflows/deploy.yml` |
| Entry | `app.route('/', flue())` in `.flue/app.ts` | Explicit `createAgentRouter(Agent)` mounts. `app.ts`, `cloudflare.ts`, `db.ts` move under `src/` | Moderate |
| Agent | `createAgent(async ctx => ...)` in `.flue/agents/project.ts`, D1 loads in the initializer | Synchronous `'use agent'` function with hooks (`useModel`, `useInstruction`, `useTool`, ...), re-rendered before every model call | Rebuild |
| Dispatch | 8 call sites in `.flue/app.ts`: `dispatch({agent:'project', id, input})` | `dispatch(ProjectAgent, {id, message})`, `message` is `user` or `signal` | Moderate |
| Tools | About 25 files use `defineTool`, `run({input})` | `run({data})`, return `{output}` (a bare string still works, other bare values throw) | Wide, mechanical |
| Provider | `registerProvider('zai-coding', ...)` in `src/agent/providers.ts` | `setProvider(createProvider(...))`, exhaustive `providers` config | Small |
| Observer | `observe()` feeding `src/slack/activity.ts` and the reaper | Events renamed (`run_start` to `agent_start`, with `instanceId` and `submissionId`) | Risk |
| Journal patch | `patches/@flue+runtime+1.0.0-beta.1.patch` | Journal internals rewritten, patch will not apply | Re-check |
| State | Agent DOs with epoch instance ids | New DO class per agent (`Flue<Name>Agent`), `deleted_classes` for `FlueRegistry`, fresh identities | Plan a cutover |
| Packages | `agents@^0.15.0` | Bundled with `@flue/vite` from 2.0.3 | Drop the dependency |

Unaffected: D1, KV, Sandbox container, Dynamic Workers, crons, Slack ingress. Conversation state inside agent DOs resets. D1 data survives. You already did a DO id reset for 1.0 (commit `0e49b60`).

Not used today, so the large 2.0 removals do not hit: MCP, Flue workflows, `session.*`, Flue SDK and React client, Flue secrets API.

### Spike: unknowns to answer first

1. **Async D1 loading.** The 2.0 agent is synchronous. Where do persona, skills, memory and connection loads go? Candidates: `useInitialData`, `usePersistentState`, or load before dispatch.
2. **`observe()` and stream beats.** The reaper and the 5-second heartbeats depend on this. The guide documents only OpenTelemetry instrumentation.
3. **Built-in tools.** Without `useSandbox()` the built-in `bash`, `read`, `write`, `edit`, `grep` and `glob` tools no longer exist. Check whether the agent relied on them.
4. **Stream-journal patch.** Does `SQLITE_TOOBIG` still occur without it?
5. **DO migrations.** Does the declarative `exports` field (Cloudflare changelog 2026-06-30) coexist with Flue's migration rules?

Spike shape: a throwaway branch with a minimal 2.2.2 agent that loads from D1, runs one tool and emits observer events into the activity store. Prior art: `docs/superpowers/plans/2026-06-18-flue-1.0-spike-findings.md`.

### 2.x features that may delete code (candidates, unchecked)

- A message arriving while a conversation is busy can join the live response. Overlaps `src/slack/absorb.ts`.
- `idempotencyKey` on dispatch. Overlaps the KV event-id claims.
- Tool `timeoutMs`, and `durable: true` tools with checkpointed `step.do`.

### Checklist (from the migration guide)

1. Pin `@flue/*` to 2.2.2. Add `vite`, `@flue/vite`, `hono`, `@cloudflare/vite-plugin`, and `@earendil-works/pi-ai` for custom providers.
2. Write `vite.config.ts`. Change scripts and CI to `vite dev` and `vite build`. Fix `flue.config.ts`. Gitignore `.flue-vite/` and `.flue-vite.wrangler.jsonc`.
3. Write `app.ts` with explicit mounts. Remove the `flue()` router.
4. Convert the agent to a `'use agent'` function with hooks.
5. Migrate tools to `run({data})` returning `{output}`.
6. Migrate providers to `createProvider` and `setProvider`.
7. Migrate observability event names and correlation fields.
8. Cloudflare: `deleted_classes` for `FlueRegistry`, `new_sqlite_classes` for the agent, move `cloudflare.ts` into `src/`, keep `compatibility_date` at `2026-04-01` or later, update `run_worker_first`, plan a drained deploy.
9. Typecheck, test, production build, inspect the merged wrangler config before deploy.
10. Update the `flue-cloudflare-agents` skill, which describes beta-era patterns.

## Tier 2: skip for now, revisit after the spike

| Item | Why it waits |
|---|---|
| AI Gateway (auto-retry, per-user spend limits, unified billing) | Nice to have. Model calls work today. |
| Workflows to replace the `*/2` sweeps and the Linear outbox | Steps are billed since 2026-08-10, sleeping and waiting count as steps. Check the price table. Overlaps Flue 2 scheduling. |
| Dynamic Workers cost check | $0.002 per unique worker per day past 1,000 a month. Only matters if `execute_code` creates unique workers per call. |
| Tracing (DO ids in logs, unified traces) | Flue 2 traces automatically once Workers Traces is enabled. |
| Agents SDK 0.22+ recovery, `runFiber`, queue lifecycle | Unconfirmed that Flue exposes them. Recovery replays turns, so Slack posts need to be idempotent. |
| Agent Memory | Private beta, no published pricing. |
| Email Service | Only if email becomes a channel. |
| Browser Run human handoff | Only if browser tasks are added. |

Tier 2 may shift after the spike. Flue 2 scheduling, tracing and idempotency could overlap with several of these.

## Not verified

- The Sandbox 1.0 breaking-change list.
- The full Workflows step-billing table.
- Blog-only claims (for example "100x faster than containers" for Dynamic Workers).
- Agents Week pages, read as summaries only.
- flueframework.com could not be opened. Migration details come from the repo's docs files.
- No GitHub release entry found for Flue 2.0.0. Details come from the changelog files.
- The changelog says persisted `format_version` 1, the guide says version 8. Reset behaviour is the same.

## Cloudflare sources

- Changelog posts: `https://developers.cloudflare.com/changelog/post/<date>-<slug>/`
- Agents SDK releases: https://github.com/cloudflare/agents/releases
- Containers and Sandbox GA: https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/
- Sandbox deprecations: https://developers.cloudflare.com/changelog/post/2026-06-09-deprecating-sandbox-sdk-features/
- Dynamic Workers pricing: https://developers.cloudflare.com/dynamic-workers/pricing
