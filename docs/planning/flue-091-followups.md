# Flue 0.9.1 Follow-Ups

**Historical reference:** This document describes an earlier runtime or experiment. Current production uses Flue 2.2.2; see the [completed cutover](../operations/2026-10-05-flue-cutover.md) and [deployment runbook](../deployment.md). Earlier reset, replay and deployment proposals are not current operating instructions. Unimplemented follow-up ideas remain proposals.

As of the npm `@flue/runtime@0.9.1` / `@flue/cli@0.9.1` release, MoreHands still needs its own
`agent_runs` and `agent_run_events` ledger. Flue workflow run history applies to finite workflows,
not dispatched persistent-agent turns.

Future work worth considering:

- Move the external coding runner shape to a separate Flue workflow when we want workflow run IDs,
  event streams, logs, typed results, and sandbox staging owned outside the MoreHands Worker.
- Use Flue subagents inside the runner/controller session for mini-swarm behavior. Do not persist
  controller topology in MoreHands; keep MoreHands to receipts, routes, dedupe, wake policy, and
  notifications.
- Revisit Cloudflare `cloudflare.ts` extension hooks only when MoreHands needs native lifecycle
  wrapping such as Sentry under Flue-owned Durable Objects.
- Watch Flue releases after `0.9.1` for the announced generated Durable Object rename to
  `FLUE_<NAME>_AGENT` / `Flue<Name>Agent`. The `0.9.1` npm package still generates `Project` for
  the `project` agent, so this migration intentionally does not rename the Durable Object class.
