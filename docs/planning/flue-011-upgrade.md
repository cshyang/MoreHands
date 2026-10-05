# Flue 0.11 Upgrade

**Historical reference:** This document describes an earlier runtime or experiment. Current production uses Flue 2.2.2; see the [completed cutover](../operations/2026-10-05-flue-cutover.md) and [deployment runbook](../deployment.md). Earlier reset, replay and deployment proposals are not current operating instructions. Unimplemented follow-up ideas remain proposals.

**Date**: 2026-06-10
**Status**: phases 1+2 deployed (branch `flue-011-upgrade`). Phase 1 live as version cfda14da (prod-smoked: PDF turn). Phase 2 live as d1a0916b: all four crons in-Worker, reminders on D1 (migration 0019), ticker source deleted. Verified in prod: a planted one-shot reminder was claimed by the minutely scan and dispatched. Remaining: confirm the reminder turn's Slack post, delete the hatchery-ticker worker from Cloudflare, merge to main. Phase 3 (native sandbox harness) not started.
**Spike**: all 0.11 claims verified live on a minimal project (see flue-cloudflare-agents skill, "0.11 spike gotchas"): `cloudflare.ts` entry, `scheduled` handler, `extend({base})` + `scheduleEvery`, `{id, input}` dispatch, native sandbox in `createAgent`, Durable Streams replay, no workerd skew.

## Why upgrade

1. **Delete the external ticker** (phase 2): `cloudflare.ts` `scheduled` handler + Agents SDK `schedule()/scheduleEvery()` via `extend({base})` make the scheduler Worker, its service binding, and the heartbeat token removable.
2. **Durable dispatches**: accepted Slack turns survive DO interruption (durable per-instance queue, conservative replay, visible interruption messages).
3. **Observability**: Durable Streams replace fibers/`wrangler tail` archaeology — `GET /agents/project/<id>` replays full turn history; `?wait=result` for sync debugging (requires `export const route`, temp only).
4. **Native sandbox** (phase 3): `sandbox: getSandbox(...)` in `createAgent` replaces our exec/read/write plumbing; audit ledger + Slack file tools stay custom.

## The breaking change that shapes everything: sessions are gone

0.11 `dispatch()` is `{agent, id, input}` — no `session`. One agent instance = one conversation. The session fan-out moves into the instance id (thread-as-instance).

**Id scheme**: `project:<projectId>:agent:<slug>/<scope>` — scope appended after `/` (scopes may contain `:`; slugs may not, so the existing parser regex extends cleanly).

| old session | new scope |
|---|---|
| `conv:<conversationId>` | `conv:<conversationId>` |
| `heartbeat:<projectId>` | `heartbeat` |
| `job:<projectId>:<jobId>` | `job:<jobId>` |
| `reflect:<projectId>:<ts>` | `reflect:<ts>` |
| `work:<projectId>:<itemId>` | `work:<itemId>` |

Accepted losses:
- **All existing thread histories orphan at cutover** (0.11 rejects pre-0.10 session state; re-keying orphans them anyway). The `messages` transcript table keeps the durable record; open threads cold-start once.
- `reflect:<ts>` now creates one DO per sweep (storage crumbs). Kept to preserve no-carryover semantics; revisit if it bothers anyone.

## Phase 1 (this branch): core upgrade, behavior-preserving

- Deps: `@flue/{runtime,sdk,cli}@^0.11.0`, `agents@^0.15.0` (new required peer). Drop root `@cloudflare/vite-plugin` devDep (0.9.1-era skew workaround; 0.11 CLI bundles a current one) unless dev breaks.
- `agentInstanceId(projectId, slug, scope?)` + `parseAgentInstanceId` strips `/<scope>`; 5 dispatch sites (4 in `.flue/app.ts`, 1 in `src/workbench/gateway.ts`) move session → scope, drop `session` key.
- `src/slack/activity.ts`: observe events no longer carry meaningful `session` — derive the `conv:` scope from `event.instanceId`; `slack_turn_activity.session_id` stores the scope string (same values as before).
- `.flue/cloudflare.ts` (new): `export { Sandbox } from '@cloudflare/sandbox'` — replaces ≤0.9.1 auto-wiring. (`.flue/` is still the first-priority source root in 0.11.)
- `wrangler.jsonc`: drop user-declared `Project`/`FLUE_REGISTRY` DO bindings (Flue generates+merges them); keep `SANDBOX`. Append migration `{ tag: "flue-011", deleted_classes: ["Project"], new_sqlite_classes: ["FlueProjectAgent"] }`. `FlueRegistry` survives unchanged.
- Gates: `npm run typecheck && npm test && npm run build`, then deploy + prod Slack smoke test (engaged mention → reply; file load; heartbeat).

## Phase 2: kill the ticker

Move heartbeat/reflect/scheduled jobs to `triggers.crons` + `scheduled` handler in `cloudflare.ts` (or per-DO `scheduleEvery` via `extend`). Export SchedulerDO reminder data or re-create via `set_reminder` before deleting the scheduler Worker, TICKER binding, and heartbeat token.

## Phase 3: native sandbox harness — evaluated and REJECTED (2026-06-10)

The plan was to swap `workspace_exec/write/read` for `sandbox: getSandbox(...)` + `cwd` in
`createAgent`. Spike evidence killed it: configuring `sandbox:` makes the harness run
`ls -1 /workspace` at **session init** (workspace skill/AGENTS.md discovery), booting the
container on EVERY turn — including pure-text replies that never touch a file. Verified on a
no-tool turn (`docker ps` empty before, container up after). The `sandbox` config accepts a
factory but init-time discovery invokes it regardless, so there is no lazy path.

For a chat coordinator where most turns are text-only, that trades a ~6s cold-start tax on
the first reply after every idle window (plus a continuously-warm paid container during any
conversation) for tools the agent has not needed (edit/grep/glob). The hand-rolled tools
boot the container only when actually used — the right shape for this agent.

**Re-entry conditions** (revisit if any holds): Flue ships lazy/deferred workspace discovery;
the coordinator demonstrably struggles with multi-file editing through `workspace_exec`; or
MoreHands grows an agent persona whose primary job is file work (that persona can set
`sandbox:` while the coordinator keeps the lazy tools — it's per-agent config).

## Out of scope

- Workflows, Chat SDK, `db.ts` adapters (Cloudflare target rejects `db.ts` anyway).
- Any model/provider changes.
