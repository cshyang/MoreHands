# Deployment

MoreHands deploys as a small control plane plus a separate coding runner.

```text
hatchery          Cloudflare Worker + Flue Durable Objects (hosts its own crons)
run-coding-task   Trigger.dev task that runs Pi + Agent Kits
```

MoreHands owns routes, run receipts, events, callback auth, and notifications. Trigger.dev hosts the
long-running coding task. The runner reports facts back to MoreHands; it does not own Linear, Slack,
merge, or production deploy authority.

For the shortest Slack + GitHub self-host path, start with
[self-hosted-quickstart.md](self-hosted-quickstart.md). This page covers the
full deployment surface and optional integrations.

## Prerequisites

- Node `>=22.18`. Flue `0.11` rejects older Node versions.
- `npm install`
- Cloudflare account + Wrangler auth.
- Trigger.dev project and secret key.
- OpenRouter key — the ONE model credential: the Worker agent (Flue runs
  `openrouter/xiaomi/mimo-v2.5-pro` inside the DO) and the Pi runner (both kits) all route
  through OpenRouter.
- Slack, Nango, Linear, and GitHub access for the workspace you are wiring.

## Cloudflare Setup

The dead-simple path is fill one file, run one command, then wire the external dashboards.

```bash
wrangler login
cp .env.deploy.example .env.deploy
$EDITOR .env.deploy
./scripts/setup.sh
```

`./scripts/setup.sh` is phaseable:

| Phase | Does |
|---|---|
| `resources` | creates D1 + KV if absent, writes ids into the env file (never into tracked `wrangler.jsonc`) |
| `migrate` | applies D1 migrations to `hatchery-skills` |
| `deploy` | builds Flue, patches the built config with the env file's resource ids, deploys `hatchery`, autofills `MOREHANDS_PUBLIC_URL` |
| `secrets` | pushes set values from `.env.deploy` to the Worker (derives `SLACK_BOT_ID` + `KNOWN_TEAM_IDS` from the bot token via auth.test) |
| `manifest [url]` | prints the Slack app manifest with the worker URL filled in, ready to paste (url defaults to `MOREHANDS_PUBLIC_URL`) |
| `doctor` | verifies the deployment leg by leg — config, worker liveness, Slack token, optional integrations — with the next step for each gap |

After you create/install the Slack app, add the Slack bot token to `.env.deploy` and rerun:

```bash
./scripts/setup.sh secrets
```

### Second account (e.g. work)

`MOREHANDS_ENV=<name>` points every phase at `.env.deploy.<name>`:

```bash
MOREHANDS_ENV=work ./scripts/setup.sh full
MOREHANDS_ENV=work ./scripts/setup.sh doctor
```

Account-specific resource ids stay in that env file; tracked files (`wrangler.jsonc`,
`trigger.config.ts`) keep the canonical instance's values, which CI continues to deploy.
A second Trigger.dev project is selected with `TRIGGER_PROJECT_REF` when running
`npm run trigger:deploy`.

## Worker Config

Everything account-specific lives in `.env.deploy` and is pushed as Worker secrets or vars.

| Secret / var | Worker | Required for |
|---|---|---|
| `OPENROUTER_API_KEY` | hatchery | model turns inside the Cloudflare agent |
| `HEARTBEAT_TOKEN` | hatchery | guards the internal cron-fired routes |
| `SLACK_SIGNING_SECRET` | hatchery | `/slack/events` verification |
| `SLACK_BOT_TOKEN_DEFAULT` | hatchery | Slack replies |
| `KNOWN_TEAM_IDS` | hatchery | Slack auto-provision allowlist |
| `SLACK_BOT_ID` | hatchery | mention detection and auto-create |
| `ADMIN_CONNECTIONS_TOKEN` | hatchery | guarded admin routes |
| `NANGO_SECRET_KEY` | hatchery | connection sessions and token fetch |
| `NANGO_WEBHOOK_SECRET` | hatchery | `/nango/webhook` verification |
| `LINEAR_WEBHOOK_SECRET` | hatchery | `/linear/webhook` verification |
| `TRIGGER_SECRET_KEY` | hatchery | dispatch to Trigger.dev `run-coding-task` |
| `TRIGGER_API_URL` | hatchery | optional; defaults to `https://api.trigger.dev` |
| `AGENT_RUNNER_TOKEN` | hatchery | runner callback auth |
| `MOREHANDS_PUBLIC_URL` | hatchery | public callback origin for Trigger.dev |
| `RUNNER_GITHUB_PAT_TEMP` | hatchery | temporary dogfood GitHub token sent to the runner |
| `GITHUB_SELF_TOKEN` | hatchery | optional; capability-request issues on MoreHands's own repo (see Self-Improvement Loop) |
| `ROUTES_AUTO_ACTIVATE` | hatchery | optional; `true` auto-activates proposed agent-run routes (single-tenant dogfood — skips the admin counter-signature; repo allowlist still enforced). Leave unset for multi-tenant. |
| `WORKBENCH_RUNNER_TOKEN`, `CODING_RUNNER_URL` | hatchery | optional source-change workbench runner |

`RUNNER_GITHUB_PAT_TEMP` is a stopgap. Production should replace it with a GitHub App installation
token minted per repo/run.

## Trigger.dev Runner

The Trigger runner is configured by [trigger.config.ts](../trigger.config.ts). It packages:

- `git`
- `@earendil-works/pi-coding-agent` (+ capability extensions)
- `agent-kits/coding-default`

Deploys happen automatically: a push to `main` touching `trigger/**`, `trigger.config.ts`,
`agent-kits/**`, or `package-lock.json` runs [.github/workflows/deploy-runner.yml](../.github/workflows/deploy-runner.yml)
(gate: typecheck + tests, then `trigger deploy`). Manual fallback: `npm run trigger:deploy`.

Set Trigger.dev environment variables for the task (dashboard → Environment Variables):

| Secret / var | Required for |
|---|---|
| `OPENROUTER_API_KEY` | all Pi model calls — kits route through OpenRouter |
| `KIT_ROOT` | optional override when packaged kit lookup differs |
| `MOREHANDS_PI_RUNTIME` | optional; `rpc` switches the pi channel, default is `cli` — runtime var, no redeploy needed |

The GitHub token and MoreHands callback token are sent in the dispatch payload by MoreHands. They do
not need to be standing Trigger.dev secrets.

### Agent kits

The dispatch payload's `kit` field (from the agent-run route config, default `coding-default`)
selects the execution path inside `run-coding-task`:

- `coding-default` — a single Pi agent, run-scoped branch `morehands/<slug>-<uuid8>`, regular PR.

Kit names are validated at route creation against `SUPPORTED_KITS` in `src/agent-runs/events.ts` —
unknown kits fail fast in the control plane instead of inside a Trigger run.

## CI Secrets (GitHub Actions)

| Secret | Workflow | Purpose |
|---|---|---|
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | `deploy.yml` | Worker deploy |
| `TRIGGER_ACCESS_TOKEN` | `deploy-runner.yml` | Trigger.dev personal access token for `trigger deploy` |

## Workspace Provider

Current M0 runner code uses a fresh local workspace inside the Trigger.dev task container. That is
acceptable only for dogfood against repos you control.

Use E2B, Vercel Sandbox, or another isolated workspace provider before running arbitrary third-party
repos. Trigger.dev is the task host; it is not the durable source of truth and should not be treated
as the safety boundary for untrusted repo execution.

```text
Git branch       code truth
MoreHands D1      run-state truth
Trigger.dev      long-running task host
Workspace        clone/edit/test filesystem
```

## External Dashboard Wiring

- Slack app event URL: `<worker-url>/slack/events`
- Slack slash command URL: `<worker-url>/slack/commands` (`/hands` — declared in
  `slack-app.manifest.json`; existing apps must re-apply the manifest to pick it up).
  `./scripts/setup.sh manifest` prints the paste-ready JSON with the worker URL filled in.
- Nango webhook URL: `<worker-url>/nango/webhook`
- Linear webhook URL: `<worker-url>/linear/webhook`

Curated providers ship hand-tuned API profiles; their Nango integration ids should use the catalog
slugs unless overridden in connection config:

```text
github
github-pat
linear
notion
```

**Any other integration enabled in the Nango project is also connectable** — no MoreHands change
needed. The agent validates the name live against `GET /integrations`, the auth webhook persists the
provider's API spec from Nango's catalog (base URL + required headers), and the call tool goes
direct for Bearer-auth providers or relays through Nango's proxy for exotic auth. Generic providers
default to `methodPolicy: get-post` (destructive verbs blocked); an operator can set
`methodPolicy: "all"` in the connection config to allow writes for one connection.

Linear should enable Issue events for `Run Agent` transitions. Comment events are needed for
continuation runs.

## Project Setup

After deploy:

1. Mention the bot in a Slack channel so the project/channel binding is created.
2. Ask the bot for setup status.
3. Connect GitHub and Linear through Nango from Slack.
4. Create a route with `propose_agent_route`. With `ROUTES_AUTO_ACTIVATE=true` (dogfood) it goes
   live immediately and step 5 is skipped; otherwise it is pending until an admin activates it:

```bash
curl -X POST \
  -H "x-morehands-admin-token: $ADMIN_CONNECTIONS_TOKEN" \
  "$MOREHANDS_PUBLIC_URL/__admin/agent-run-routes/<route-id>/activate"
```

Then move a Linear issue into the configured `Run Agent` state. The expected loop is:

```text
Linear state transition
  -> MoreHands agent_run + event receipt
  -> Trigger.dev run-coding-task
  -> Pi edits repo and opens/updates PR
  -> MoreHands callback
  -> Linear comment from MoreHands
```

The runner should report `pr_opened` when the PR is ready for review. Completion should come from a
real terminal signal such as PR merge, deploy, failure, or an explicit future policy decision.

## Self-Improvement Loop (capability requests)

Optional. Lets the agent turn "can you do X?" moments in Slack into GitHub issues on MoreHands's OWN
repo (the `file-capability-request` skill: offer → explicit human confirmation → dedupe against open
`capability-request` issues → file with the verbatim ask + requester + channel). The proposal queue
lives with the code, not in any tenant's tracker. Filing is human-gated per request; pickup is
human too — no automated dispatch from these issues yet.

Provisioning (three steps, no deploy):

1. **Credential** — a fine-grained GitHub PAT: repository access = ONLY the MoreHands repo,
   permissions = Issues read/write (Metadata read is implied). Narrow token, loose fence: the
   connection's `get-post` policy allows POST broadly, so the token's own scope is the guard.

```bash
npx wrangler secret put GITHUB_SELF_TOKEN
```

2. **Connection** — a `github-self` row for the channel, Worker-secret backend. `config.api` is a
   hand-set provider spec, so the generic dynamic profile serves it (direct Bearer calls, `get-post`
   default). Via the guarded admin route:

```bash
curl -X POST -H "x-morehands-admin-token: $ADMIN_CONNECTIONS_TOKEN" \
  -H "content-type: application/json" \
  "$MOREHANDS_PUBLIC_URL/__admin/connections" -d '{
    "projectId": "<channel-id>", "provider": "github-self",
    "tokenRef": "GITHUB_SELF_TOKEN",
    "config": { "repo": "<owner>/<repo>", "api": {
      "baseUrl": "https://api.github.com", "authMode": "OAUTH2",
      "headers": { "x-github-api-version": "2022-11-28", "accept": "application/vnd.github+json" } } }
  }'
```

3. **Skill** — `file-capability-request`, saved at `__global__` scope so every channel inherits it
   (a channel can override by name). Teach it in Slack and have the agent `save_skill` it, or seed
   the row directly.

The `github-self_call_api` tool appears the moment the secret exists — `connectionState` gates on
the env var, no deploy or restart. Related but separate: a tenant github connection can be opened
for writes on the PROJECT repos by setting `methodPolicy: "get-post"` in its connection config
(destructive verbs stay blocked; `"all"` is a deliberate per-connection operator decision).
