# Flue Native Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the native Flue 2 migration and recoverable F2 answer delivery, verify it, then merge locally.

**Architecture:** Flue persists and recovers conversations; the gateway supplies fresh trusted context. A thin Slack outbox stages settled answers and reconciles ambiguous fresh posts.

**Tech Stack:** TypeScript, Flue 2.2.2, Vite, Cloudflare Workers/DOs/D1, Valibot, Hono.

**Spec:** `docs/superpowers/specs/2026-10-01-flue-native-migration-design.md`

## Global Constraints

- Pin Flue runtime and Vite plugin to `2.2.2`, Pi AI to `0.87.1`.
- Keep `Project`, `FlueProjectAgent`, and `FLUE_PROJECT_AGENT` names.
- No Sandbox/MCP upgrades or debounce subsystem.
- No push, deployment, production data mutation, or real Slack posts.
- Any real model canary uses only `zai/glm-5.3-flash`.
- Preserve unrelated main-checkout changes and historical migration files.

## Review Focus

- Joined deliveries: every completed no-tool answer step belongs to the response, not only the last one.
- Lost observer on restart: native history and durable admission tracking must recover delivery.
- Ambiguous fresh post: no blind retry when Slack acceptance is unknown.
- Quiet autonomous runs: final narration must not bypass explicit posting intent/budgets.
- Receipt race: late activity writes must not overwrite a final reply or resurrect a completed receipt.

---

### Task 1: Native tool contracts

**Files:** existing tool factories and their tests under `src/{agent,agent-runs,knowledge,providers,connections,project,skills,workspace,code-mode,setup,workbench}`, `src/review.ts`, `src/shared/test-utils.ts`.

**Interfaces:** native `defineTool({name,description,input,run})`; direct tests validate `tool.input` and invoke `tool.run({data,toolCallId,log})`.

- [ ] Convert every TypeBox schema to Valibot without broadening authorization or required arguments.

```ts
import * as v from 'valibot';
defineTool({ name: 'example', description: 'Read one item.',
  input: v.object({ id: v.string() }),
  run: async ({ data }) => JSON.stringify(await read(data.id)),
});
```

- [ ] Rewrite direct invocation helpers to native run and parse input before execution.
- [ ] Run all migrated tool tests with network mocked; retain operation-specific audited timeouts.
- [ ] Typecheck the native tool contracts. Commit the coherent migration after integration checks.

### Task 2: Build, agent, gateway

**Files:** `package.json`, lockfile, `vite.config.ts`, `flue.config.ts`, `wrangler.jsonc`, CI/setup, `src/app.ts`, `src/cloudflare.ts`, `src/gateway/dispatch.ts`, `src/agent/{project,context,prompt}.ts`, `src/connections/runtime.ts`, bindings/activity/tests.

**Interfaces:** `loadProjectContext(env:Record<string,unknown>,id:string):Promise<ProjectContext>` returns serializable nonsecret facts. Gateway `dispatchProject(env,request)` loads that snapshot and calls native dispatch. `Project({id})` is synchronous and registers native hooks/tools.

- [ ] Test fresh snapshot, first render, secret exclusion, native catalog unknown-model rejection, and assistant-only activity before replacing old entrypoints.
- [ ] Native dispatch carries product input as JSON and trusted metadata as signal attributes:

```ts
await dispatch(Project, { id,
  message: { kind: 'signal', type: 'morehands.input',
    body: JSON.stringify(input),
    attributes: { snapshot: JSON.stringify(snapshot), input: JSON.stringify(input),
      eventId, engaged: 'true', conversationId } },
  initialData: snapshot,
});
```

- [ ] Mount explicit Project routing; protect internal/runtime mutation routes. Preserve all scheduled/work/review/reflection/overhear dispatch families.
- [ ] Mount reply tool only for explicit autonomous posting mode; engaged mode uses ordinary final text.
- [ ] Remove custom wrappers/journal patch/absorb queue runtime; retain existing pending data for drained cutover. Remove generic six-hour heartbeat, not product clocks.
- [ ] Native retry owns active submissions; remove the scheduled legacy reaper rather than adding another execution clock. Native settlement recovery closes receipts.
- [ ] Bump instance generation; preserve class names/history. Build via Flue Vite plugin before Cloudflare plugin with `flueWorkerConfig()`.
- [ ] Verify scheduler known/unknown expressions, full typecheck/build and generated-config dry-run.

### Task 3: Durable final answer capture and external delivery

**Files:** `src/slack/{delivery,reply-outbox,reconcile-post,post}.ts` and tests; migrations `0029_slack_reply_outbox.sql` and native capture-ledger migration; gateway adapter/reconcile wiring.

**Interfaces:** `stageReply(db,{instanceId,responseId,target,text,persona?,editTs?,maxChars?,now?}):Promise<void>` atomically stages chunks. `deliverReplyPart(db,env,id,{now?,transport?}):Promise<'sent'|'waiting'|'uncertain'>`. Native capture uses the pinned canonical record store through one isolated adapter and stable response IDs, with admission ledger seeded before dispatch. Actual Worker acquisition and record identities must be integration-tested; folded public history alone loses no-tool step boundaries.

- [ ] Test that replay capture returns every completed answer step but excludes reasoning/tool narration; joined admissions map to one settled response.
- [ ] Seed tracker before dispatch. Recovery cron reads native history so lost observer callbacks cannot lose answers.
- [ ] Atomic staged chunks dedupe by instance/response/index:

```sql
INSERT INTO slack_reply_outbox (...)
SELECT ... FROM json_each(?) WHERE true
ON CONFLICT(delivery_id) DO NOTHING;
```

- [ ] Claim delivery by conditional status/lease update returning the owned row; prevent concurrent sends.
- [ ] Engaged answers are fresh posts below the working ack, so cross-isolate late progress cannot overwrite answers. Posts carry exact delivery metadata; expired claims reconcile only positive history matches. Preserve unresolved outcomes.
- [ ] Test repeated stage, blank output, edit replay, accepted post before crash, unknown post with no match, definite rejection retry, concurrent claims, chunk ordering, missing secret, quiet mode, receipt race, and transcript dedupe.
- [ ] Run local fake-Slack integration against native history; no unapproved model/provider or real Slack call.

### Task 4: Review and local merge

**Files:** README/deployment docs, whole branch.

- [ ] Update actual commands, credentials, model default, source layout and cutover/reconciliation limits.
- [ ] Run `npm run typecheck && npm test && npm run build` fresh after all edits.
- [ ] Run `npx wrangler deploy --dry-run --config dist/hatchery/wrangler.json` without publishing.
- [ ] Fresh independent review focuses on the five failure modes above; fix and rerun affected checks.
- [ ] Commit only scope-linked files with required attribution. Merge locally without discarding/stashing unrelated main work; no push or deployment.
- [ ] Report hashes, fresh checks, and any canary/platform limits honestly.
