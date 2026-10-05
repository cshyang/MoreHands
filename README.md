# MoreHands

MoreHands is an Apache-2.0 maintainer automation platform for teams that live in
Slack. Each bound channel gets a long-running AI teammate on Cloudflare Workers:
it remembers project context, brokers provider connections, coordinates coding
runs, and leaves deterministic audit trails around anything that touches source
code or external systems.

Slack is the front door; each bound channel gets its own agent running in a
Durable Object (via [Flue](https://flueframework.com)); Linear state transitions
can dispatch an external Trigger.dev-hosted Pi runner; provider connections
(GitHub, Linear, Notion) are brokered through Nango.

## Why this exists

Small open-source projects lose time in the gaps around the actual code:
triaging issues, remembering project-specific context, reviewing changes,
running release chores, and moving work across Slack, GitHub, Linear, and docs.
MoreHands explores a lightweight, self-hostable control plane for those
maintainer workflows.

The project is intentionally not a black-box autonomous coder. The model sits
between deterministic layers: ingress is verified and deduped in code, tools are
gated by explicit connection state, coding runs report through a versioned
contract, and state lands in D1/KV ledgers that maintainers can inspect.

Current status: early-stage and actively dogfooded. The repository is public so
other agent builders and OSS maintainers can inspect the architecture, reuse the
patterns, and help harden the maintainer workflows.

The [Flue 2 production cutover](docs/operations/2026-10-05-flue-cutover.md) completed
on 2026-10-05. Slack intake now commits to D1 before acknowledgement and recovers
preparation and exact native admission after interruption.

## Maintainer workflows

- Slack-native project assistant with per-channel memory and personas.
- GitHub, Linear, Notion, and generic API connections through Nango.
- Linear-triggered coding runs through a Trigger.dev-hosted Pi runner.
- Workspace and code-mode tools with explicit limits and audit records.
- Nightly memory/reflection jobs plus scheduled reminders.
- Deterministic setup/status checks for deployments and integrations.

It deploys as **one Cloudflare Worker plus one Trigger.dev runner**
(the old `hatchery-ticker` cron worker is gone — the clock moved in-house):

```
hatchery          Slack/Linear/Nango ingress + cron clock + agent DOs + sandbox container
run-coding-task   a Trigger.dev task that runs Pi + Agent Kits and calls MoreHands back
```

## Architecture

Five layers. The model's judgment is deliberately sandwiched between two deterministic
ones: the gateway above it filters what is worth a model call, the execution layer below
it does only what it is told and leaves an audit row. Token spend and blast radius are
both pinched at the agent layer.

```mermaid
flowchart TB
    A["`**Ingress** — events enter
    Slack · Linear · Nango · crons`"]
    B["`**Gateway** — decisions in code
    verify · dedupe · route (no model)`"]
    C["`**Agent** — decisions by model
    one Flue DO per conversation`"]
    D["`**Execution** — muscle
    sandbox · code snippets · Trigger.dev pi runner`"]
    E["`**State** — what survives
    D1 (product ledgers) · native Flue history`"]
    A --> B --> C --> D --> E
```

Each agent instance has its own native conversation. Instance ids are
`project:<projectId>:agent:<slug>/<scope>@g2` where the scope picks the lane:
`conv:<conversationId>` (Slack threads), `job:<jobId>` (reminders),
`reflect:<ts>` (nightly REM), `work:<itemId>` (workbench), and separate review/overhear lanes.
The generation suffix starts fresh native Flue state without deleting prior Durable Objects.

### Life of a Slack turn

```mermaid
sequenceDiagram
    participant S as Slack
    participant A as Hono app
    participant I as D1 inbox
    participant D as agent DO (conv scope)
    S->>A: event (mention / thread message)
    A->>A: verify signature and bound event
    A->>I: atomically commit event and producer ownership
    A-->>S: HTTP 200 after durable acceptance
    A->>I: lease preparation, freeze route and acknowledgement intent
    A->>I: store immutable native request in bounded chunks
    A->>D: dispatch exact stored request with original key
    A->>I: associate tracker and release producer
    D->>D: render prompt and native tools from snapshot
    D->>S: activity receipts while working
    D->>D: native join + durable completed answer steps
    D->>D: durable wake reads settled native answer steps
    D->>S: deliver staged final answer below working ack
    D->>D: deduplicated transcript and receipt completion
    Note over I,D: Cron recovers preparation, native handoff and uncertain posts
```

### The cron clock

Flue has no scheduler. The Worker hosts its own crons
(`wrangler.jsonc` `triggers.crons`, mirrored as constants in `src/cloudflare.ts`).
Each fire calls a token-guarded internal route in-process via `app.fetch` — same routes and
guards the external ticker used to hit, minus the second worker. Crons are UTC, no DST shift.

| Cron | Route | Purpose |
|---|---|---|
| `0 19 * * *` | `/__internal/reflect-sweep` | nightly REM at 03:00 KL — consolidate transcripts into memory |
| `*/2 * * * *` | `/__internal/slack-ingress/reconcile`, `/__internal/agent-runs/reconcile`, `/__internal/replies/reconcile`, `/__internal/review-sweep` | four budgeted recovery phases with rotating first access |
| `* * * * *` | `/__internal/scheduled` (per due job) | agent-set reminders, stored in D1, claimed via CAS |

## Module map

| Module | What it does |
|---|---|
| `src/app.ts` | Worker entry: all HTTP ingress (Slack events/commands, Linear + Nango webhooks, `__internal`/`__admin` routes) |
| `src/cloudflare.ts` | Product cron clock, `Sandbox` export, retired registry namespace preservation |
| `src/agent/project.ts` | The agent definition: assembles skills, memory, connections, and tools per instance |
| `src/agent` | System-prompt assembly and the agent's self-status tool |
| `src/project` | Channel→project bindings, conversation reply targets, model resolution (D1: `bindings`, `conversation_targets`) |
| `src/slack` | Durable inbox and request chunks, activity receipts, answer outbox, blocks, slash commands, file auth |
| `src/gateway` | Leased intake preparation and native handoff, token auth, cron parser (KL-aware), reminders store (D1: `reminders`) |
| `src/cutover` | Admission fence, producer accounting, fleet/product diagnostics and evidence validation |
| `src/knowledge` | Memory + reflection: durable project facts and the nightly REM consolidation (D1: `memories`, `messages`) |
| `src/skills` | Agent-authored skills as SKILL.md docs with an active/archived lifecycle (D1: `skills`) |
| `src/connections` | Provider connection broker over Nango: OAuth/PAT/App modes, per-provider tools (D1: `connections`) |
| `src/providers` | The provider integrations themselves: GitHub read tools, generic API tool, Nango client |
| `src/agent-runs` | Control plane for external coding runs: lifecycle, routes, dispatch, reconcile (D1: `agent_runs`) |
| `src/workbench` | Internal work-item runner; dispatches to flue/Trigger.dev/webhook targets (D1: `work_items`, `work_runs`) |
| `src/workspace` | Sandbox container tools: exec, file I/O, Slack file loading |
| `src/code-mode` | Small JS/Python snippets in isolated Dynamic Workers, with an audit ledger |
| `src/setup` | Setup-status tool: what's connected, what's missing |
| `src/config`, `src/shared` | Deployment config (team allowlist) and cross-cutting utils (redaction, byte bounds, KV idempotency) |
| `trigger/` | The Trigger.dev `run-coding-task`: spawns Pi, manages branch/PR, parses the RPC stream |
| `agent-kits/` | Markdown agent definitions + skills for the Pi runner (`coding-default` live; `delivery` — the gated plan→implement→review pipeline — wired end-to-end but not yet activated on any route) |

Bindings: D1 `hatchery-skills` (`DB`), KV `SLACK_EVENTS`, DO `SANDBOX` (container), and a
Dynamic Worker loader. Flue generates the agent DO binding `FLUE_PROJECT_AGENT` itself.
Flue 2.2.2 owns conversation history, execution retries, joined deliveries, and stream persistence.
The Slack reply outbox tracks external delivery only; it does not replace Flue's history.
One pinned internal adapter reads canonical assistant-step records because folded public history loses
the distinction between tool narration and final answers. It also reads durable admission metadata
to heal a dispatch receipt lost before canonical input is written. Unknown post outcomes require a positive
Slack metadata match; they are never blindly reposted.

Deeper docs: [docs/deployment.md](docs/deployment.md) (setup, secrets, dashboard wiring),
[docs/runner-contract.md](docs/runner-contract.md) (MoreHands ⇄ runner protocol),
[docs/decisions/](docs/decisions/) (ADRs), [docs/planning/](docs/planning/) (design notes,
including the [Flue 0.11 upgrade](docs/planning/flue-011-upgrade.md)).

---

## Day-to-day

```bash
npm test           # full suite (tsx)
npm run typecheck  # tsc --noEmit
npm run dev        # local Worker
```

Pushing `main` runs the guarded production workflow: typecheck, tests, remote migration
check, fenced build and configuration validation, then deployment preserving live vars
and skipping container rollout. See [deployment.md](docs/deployment.md#flue-2-cutover)
for the manual equivalent and fence operations.

After adding a migration, `wrangler d1 migrations apply hatchery-skills --remote` (also run by
`./scripts/setup.sh migrate`). The migration history is tracked in the `d1_migrations` table.

## Local dev

Put a throwaway `ZAI_API_KEY` (and any secrets you want to exercise) in `.dev.vars`, then
`npm run dev`. Use `zai/glm-5.3-flash` for migration canaries. Local model and fake-Slack tests do
not prove production delivery or Cloudflare rollout safety; deploy separately after reviewing
[the deployment procedure](docs/deployment.md#flue-2-cutover).
