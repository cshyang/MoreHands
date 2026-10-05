# Flue Cutover Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Native execution with one whole-change OpenAI review is recommended; execution awaits the user's plan review.

**Goal:** Prepare locally testable admission fencing, matching-runtime observations, and Slack metadata registration for a controlled beta-to-Flue-2 cutover, without claiming production drain or deploying anything.

**Architecture:** D1 owns a small application-admission control row and nonexpiring producer registrations. Native Flue continues to own execution and recovery. Beta diagnostics live in a separate baseline-based bridge tree; native diagnostics extend the existing Flue 2 reply extension. A pure evidence evaluator reports coverage-qualified `blocked`, `unknown`, or `observed-idle`, never deployment permission.

**Tech Stack:** TypeScript, Hono, D1/SQLite, Cloudflare Durable Objects; native Flue runtime/Vite 2.2.2; separate beta runtime/SDK/CLI 1.0.0-beta.1 and Agents SDK 0.15.0; existing tsx test runners and node:sqlite.

**Spec:** `docs/superpowers/specs/2026-10-01-flue-cutover-safety-design.md` — approved by the user on 2026-10-01. This plan is not yet approved.

## Global Constraints

- Local hardening only. No additional production mutation, push, deployment, remote migration application, real model request, or Slack post.
- Any later model canary uses only `zai/glm-5.3-flash`.
- Keep `Project`, `FlueProjectAgent`, and `FLUE_PROJECT_AGENT`; preserve namespaces and historical migration tags.
- Never print, log, or commit credentials. Tests use fake tokens and faux/local providers only.
- Preserve unrelated work, the current host-managed worktree, native dependency pins, and prior evidence.
- Beta retains its pinned dependencies and existing stream-journal patch in a separate change set. Do not put beta execution code/dependencies back into native main.
- No custom model queue, execution retry, history store, generic bypass header, or automatic producer expiry/replay.
- New intake is fenced before its first consuming side effect. Existing accepted work, callbacks, and delivery recovery remain available.
- Diagnostics must never contact beta storage through Flue 2; mismatch rejects before namespace access.
- Missing schemas, coverage, format identity, or callback interpretation are unknown, not zero.
- No automatic commit, merge, or worktree deletion in this plan. Keep changes local for review; commit/integration requires user authorization.
- All delegated work uses OpenAI or ZAI through opencodex; explicitly set `model: "haiku"` as the routing placeholder for an ocx agent. No Anthropic subagents.

## Review Focus

Each risk below has an owning test in the tasks; independent review also checks the surrounding boundaries.

1. Reminder intake admitted before closure deletes a one-shot, then internal routing tries to obtain a second admission and rejects it: reuse the existing producer scope, not an HTTP bypass. Task 3.
2. Linear responds before deferred dispatch finishes: registration must remain present until the actual dispatch promise settles. Task 2.
3. Unknown native/SDK schemas or capped inventory omit unfinished work: complete counts plus strict format/column checks must fail closed. Tasks 4–6.
4. Beta receipt reaper redispatches or resets epochs during observation: cutover mode must suppress it while retaining accepted parked-message drain. Task 5.
5. A closed fence is mistaken for lossless ingress or safe rollback after g2 activity: reports and deployment documentation must keep those claims separate. Tasks 6–7.

## Execution layout and evidence

Current native tree: the active host worktree, branch `flue-2-spike`, migration commit `40fd12a`. Do not change the original main checkout.

Prepare the beta bridge from baseline `62beadc` in an additional local worktree, not by changing the active host checkout's dependencies. At execution time use the worktree skill, inspect the target first, then create branch `flue-cutover-bridge` at that baseline and worktree `.claude/worktrees/flue-cutover-bridge` under the repository root. If the branch/path already exists, inspect it and reuse only if it is the intended bridge; do not reset/delete it. Commands remain anchored to explicit worktree paths; do not `cd` to the original main checkout.

Create a plan-owned git-ignored evidence workspace via the execution skill. Record RED/GREEN output, baseline/native revision IDs, dependency/patch hashes, generated config inspection, and final checks there. Do not reuse another plan's ledger for this plan.

The bridge source baseline is a local candidate, **not a verified match to the deployed bundle**. That verification remains a production gate. No script in this plan calls Cloudflare or Slack merely because it is named a preflight.

## File responsibilities

| File | Responsibility |
|---|---|
| `migrations/0032_cutover_control.sql` | Shared additive admission/control schema, initially closed |
| `src/cutover/admissions.ts` | Atomic intake/drain registration, closure CAS, explicit configuration validation |
| `src/cutover/producer.ts` | One registered operation lifetime, including child promises |
| `src/cutover/test-fixtures.ts` | Test-only real SQLite/D1 adapter and deferred promises |
| `src/app.ts` | Verified ingress registration and authenticated control/diagnostic routes |
| `src/gateway/scheduled.ts` | Existing input assembly remains; new scheduled dispatch helper lives separately |
| `src/gateway/scheduled-dispatch.ts` | Shared per-job handler, callable inside an already-admitted reminder scan |
| `src/cloudflare.ts` | Reminder admission before consuming scan; existing recovery routes continue |
| `src/cutover/native-observation.ts` | Pure pinned g2 SQL reader, no native initialization |
| `src/cutover/observation.ts` | Version-neutral observation types and conservative interpretation |
| `src/slack/reply-runtime.ts` | Add g2 diagnostic RPC to existing extension; preserve recovery behavior |
| `src/cutover/diagnostics.ts` | Authenticated version routing before DO access, no setName bootstrap |
| `src/cutover/evidence.ts` | Coverage/product evidence aggregation, no production API client |
| `scripts/cutover-report.ts` | Offline JSON-file report command with strict input validation |
| `scripts/check-cutover-config.ts` | Build-artifact/config validation; no deploy |
| `slack-app.manifest.json` | Add outgoing reply metadata registration only |
| `docs/deployment.md` | Actual bridge/cutover/reopen/rollback gates and additive Slack patch |
| Beta `.flue/app.ts`, `.flue/cloudflare.ts`, `.flue/agents/project.ts` | Bridge integrations in baseline tree only |
| Beta `src/cutover/beta-observation.ts`, `src/cutover/beta-runtime.ts` | Pinned beta reader and supported extension seam only |

Every production file has colocated `.test.ts` coverage and is added explicitly to that tree's `npm test` chain. Test-only fixture files are not imported by production.

### Task 1: Shared atomic admission control

**Files:** Create `migrations/0032_cutover_control.sql`, `src/cutover/admissions.ts`, `src/cutover/producer.ts`, `src/cutover/test-fixtures.ts`, `src/cutover/admissions.test.ts`; modify `package.json` test chain.

**Interfaces:**

```ts
export type Generation = 'g1' | 'g2';
export type ProducerSource = 'slack' | 'linear' | 'scheduled' | 'work-item'
  | 'reminder-scan' | 'reflect' | 'review' | 'heartbeat';
export interface CutoverEnv { CUTOVER_CONTROL?: unknown; DB?: D1Like }
export interface Admission { id: string; generation: Generation; source: string }
export class AdmissionUnavailable extends Error {}
export function beginIntake(env: CutoverEnv, generation: Generation,
  source: ProducerSource, id?: string, now?: number): Promise<Admission | null>;
// null means explicitly unconfigured ordinary deployment, not rejection.
export function beginDrain(env: CutoverEnv, generation: Generation,
  source: 'accepted-runs' | 'parked-messages', id?: string, now?: number): Promise<Admission | null>;
export function releaseAdmission(db: D1Like, admission: Admission): Promise<void>;
export function setAdmissionState(db: D1Like, expectedRevision: number,
  state: 'open' | 'closed', now?: number): Promise<boolean>;
export interface ProducerScope {
  admission: Admission | null;
  track<T>(promise: Promise<T>): Promise<T>;
  finish(succeeded: boolean): Promise<void>;
}
export function createProducerScope(env: CutoverEnv,
  admission: Admission | null): ProducerScope;
```

`beginDrain` is called only by trusted recovery call sites. It is not an externally selectable admission kind. Intake rejects closure/config/schema failures with `AdmissionUnavailable`. Release errors preserve the durable marker. `finish(false)` preserves the marker because an operation may have consumed state without completing its dispatch. No timeout releases it.

- [ ] **Step 1: Write failing tests using real SQLite.** The test fixture wraps `DatabaseSync(':memory:')` in the existing D1Like shape with `meta.changes`; production imports no test hooks.

```ts
const f = sqliteD1();
f.sql.exec(readMigration('0032_cutover_control.sql'));
const env = { DB: f.db, CUTOVER_CONTROL: 'd1' };
assert.equal(await setAdmissionState(f.db, 0, 'open', 1), true);
const before = await beginIntake(env, 'g2', 'slack', 'before', 2);
assert.ok(before);
assert.equal(await setAdmissionState(f.db, 1, 'closed', 3), true);
await assert.rejects(beginIntake(env, 'g2', 'slack', 'after', 4), AdmissionUnavailable);
assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM cutover_producers').get()!.n, 1);
const child = deferred<void>();
const scope = createProducerScope(env, before);
scope.track(child.promise);
const finished = scope.finish(true);
await Promise.resolve();
assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM cutover_producers').get()!.n, 1);
child.resolve();
await finished;
assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM cutover_producers').get()!.n, 0);
```

Test fixture contract and minimal implementation:

```ts
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function sqliteD1() {
  const sql = new DatabaseSync(':memory:');
  const db: D1Like = { prepare: query => ({ bind: (...values) => ({
    run: async () => ({ meta: { changes: Number(sql.prepare(query).run(...values as never[]).changes) } }),
    first: async <T>() => (sql.prepare(query).get(...values as never[]) ?? null) as T | null,
    all: async <T>() => ({ results: sql.prepare(query).all(...values as never[]) as T[] }),
  }) }) };
  return { sql, db };
}
export function readMigration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}
```

Keep `DatabaseSync`, `readFileSync`, and D1Like imports explicit in the test utility. Separate tests: closed initial state; absent setting preserves ordinary behavior; blank/nonstring/invalid nonempty config is rejected; enabled mode missing DB/table/row rejects; missing `meta.changes` rejects; failed child preserves marker; `finish(false)` preserves marker; stale close revision fails; drain works while closed but invalid control does not; markers survive large clock advances and a fresh helper instance. Test both orderings of closure versus registration, not a fake process lock.

- [ ] **Step 2: Run RED.** `npx tsx src/cutover/admissions.test.ts` — initially missing imports; once test scaffold is valid, observe failure on missing atomic registration/lifetime behavior. Record actual failures; import errors alone are not the behavioral RED.

- [ ] **Step 3: Implement the additive migration and atomic statements.**

```sql
CREATE TABLE cutover_control (
  id INTEGER PRIMARY KEY CHECK(id=1),
  state TEXT NOT NULL CHECK(state IN ('open','closed')),
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO cutover_control VALUES (1,'closed',0,0);
CREATE TABLE cutover_producers (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  generation TEXT NOT NULL CHECK(generation IN ('g1','g2')),
  kind TEXT NOT NULL CHECK(kind IN ('intake','drain')),
  admitted_at INTEGER NOT NULL
);
CREATE INDEX idx_cutover_producers_admitted ON cutover_producers(admitted_at);
```

Intake registration is one statement; do not read then insert:

```sql
INSERT INTO cutover_producers(id,source,generation,kind,admitted_at)
SELECT ?,?,?,'intake',? FROM cutover_control
WHERE id=1 AND state='open';
```

Drain registration uses `state IN ('open','closed')` and kind `drain`, so a missing row still fails. Require exactly one changed row in the D1 result. Closure/opening uses:

```sql
UPDATE cutover_control SET state=?,revision=revision+1,updated_at=?
WHERE id=1 AND revision=?;
```

Release deletes only the exact ID/generation/source tuple. Scope tracks child promises with rejection handling attached immediately, waits for all tracked children, and releases only after successful producer completion and successful children. `track` must attach a rejection observer without turning the returned original promise into success. `finish` waits until the pending set is empty, including children registered by an already-tracked parent before it settles; it does not snapshot only the initial child array. Reject attempts to register children after release. Add a nested-deferred-child test and a late-track-after-release test. Do not schedule cleanup or replay. Use the raw D1 binding rather than a read-replica session for control operations; the conditional write executes on primary.

- [ ] **Step 4: GREEN and full suite.** `npx tsx src/cutover/admissions.test.ts && npm run typecheck && npm test`. Expected: behavioral tests pass, existing suite passes; actual counts recorded. Apply all migrations to a fresh local SQLite fixture and also apply only 0032 after the baseline migration set. No remote apply.

- [ ] **Step 5: Record evidence and keep local.** Add the new test file to `npm test`, run `git diff --check`, ledger atomic-ordering/lifetime results. No commit unless separately authorized.

### Task 2: Fence verified HTTP intake and retain deferred ownership

**Files:** Modify `src/app.ts`, `src/slack/ack.ts`, `src/slack/ack.test.ts`; create `src/cutover/ingress.test.ts`, `src/cutover/ingress-test-fixture.ts`; modify `package.json` test chain.

**Consumes:** Task 1 `beginIntake`, `createProducerScope`, `AdmissionUnavailable`.
**Produces:** One scope per verified intake; no scope granted by request headers. Internal callbacks/commands remain outside intake gates.

- [ ] **Step 1: Write route-level failing tests.** Transpile/load the real app in a test VM with explicit stubs for Worker-only imports, following `src/config/deployment.test.ts`. Use actual Hono, real SQLite control/product migrations, real signature helpers, and a test execution context collecting `waitUntil` jobs. Load local business modules through the tsx-enabled test process; do not replace `handleLinearWebhook`, work-item creation, KV claims, or watermark functions with always-success stubs. Stub native dispatch at `./gateway/dispatch`, observer registration at `@flue/runtime`, and external fetch boundaries only. Wrap the actual SQLite adapter and KV fixture to record writes, preserving real side effects and query results. Never invoke `Project` to make a real request.

```ts
const f = await ingressFixture({ state: 'closed', generation: 'g2' });
const slack = await f.signedSlack({ type: 'event_callback', event_id: 'E',
  team_id: 'T', event: { type: 'app_mention', channel: 'C', user: 'U', ts: '1.0', text: '<@BOT> hi' } });
assert.equal(slack.status, 503);
assert.deepEqual(f.effects, []); // no binding/target/KV/transcript/ack/files/dispatch
assert.equal((await f.signedSlack({ type: 'url_verification', challenge: 'test' })).status, 200);
assert.equal((await f.unsignedSlack()).status, 401);
assert.equal((await f.internal('/__internal/scheduled', { fireId: 'F', projectId: 'P', jobId: 'J' })).status, 503);
assert.equal((await f.internal('/__internal/work-items', { projectId: 'P', title: 'work' })).status, 503);
```

Fixture interface must be defined in `src/cutover/ingress-test-fixture.ts`, not production:

```ts
interface IngressFixture {
  sql: DatabaseSync;
  effects: string[];
  signedSlack(body: Record<string, unknown>): Promise<Response>;
  unsignedSlack(): Promise<Response>;
  internal(path: string, body: unknown): Promise<Response>;
  signedLinear(body: Record<string, unknown>, event: 'Issue' | 'Comment'): Promise<Response>;
  close(): Promise<void>;
  finishJobs(): Promise<void>;
  runnerDispatch: ReturnType<typeof deferred<Response>>;
}
```

`ingressFixture` applies all product migrations, opens/closes the actual control row to the requested fixture state, creates a KV Map with real `get`/`put`, and loads the actual app. Use `createRequire(import.meta.url)` for business-module requires and VM override only for the three listed external/native boundaries. Construct Slack signatures using Web Crypto over literal `v0:<current timestamp>:<raw JSON>` and Linear signatures over raw JSON; fake keys live only in fixture variables. The external fetch double handles only expected Slack/Trigger URLs and throws on any other URL. `finishJobs` drains all captured context promises, including jobs appended by jobs. Make failed dispatch observable in the durable product row as well as the producer marker.

Separate open-state tests prove the same routes still reach their real consumer boundaries. Deferred Linear test starts an open-state request, holds a mocked actual runner dispatch promise, closes control, observes the producer row after the HTTP response, resolves dispatch, awaits context jobs, then observes release. Test bad Linear HMAC retains 404 and makes no registration. Test DB failure before effects. Verify a failed deferred dispatch leaves a registration, not silent cleanup.

Keep existing authenticated runner/source-change callbacks, connection callbacks, and slash commands callable while closed. Assert their existing behavior through real route invocation, not just the absence of a route name in a blocking list. Any unresolved callback/network boundary remains a production observation limit, not a global certificate.

- [ ] **Step 2: Run RED.** `npx tsx src/cutover/ingress.test.ts`. Expected valid signed intake currently consumes effects/returns success instead of 503; the deferred lifetime assertion currently finds no registration.

- [ ] **Step 3: Integrate scopes after authentication and before effects.** For Slack, wrap the existing body after `slackUserMessageEvent` and before the first `bindingBySlack`/auto-create. URL challenges and ignored non-user events keep current responses. Internal intake calls `requireHeartbeat` before acquiring a scope. Linear first calls the existing `verifyLinearWebhook` on the unchanged raw body, then acquires a scope and invokes the existing handler; keep handler verification as defense in depth rather than adding an unsafe verified flag.

Use this lifecycle pattern without broad app refactoring:

```ts
let scope: ProducerScope;
try {
  scope = createProducerScope(c.env, await beginIntake(c.env, 'g2', 'linear'));
} catch (error) {
  if (error instanceof AdmissionUnavailable) return c.json({ error: 'admissions unavailable' }, 503);
  throw error;
}
let succeeded = false;
try {
  const result = await handleLinearWebhook(linearReq, linearDeps);
  if (result.dispatch) {
    const dispatching = scope.track(result.dispatch());
    c.executionCtx.waitUntil(dispatching.catch(() => {}));
  }
  succeeded = result.status < 400; // handler errors can occur after durable writes
  return c.json(result.body ?? {}, result.status as 200 | 400 | 500);
} finally {
  c.executionCtx.waitUntil(scope.finish(succeeded));
}
```

Use the same ownership rule for both Comment and Issue events. Keep marker release out of handlers that swallow dispatch failure: the gateway work-item handler returns `dispatchStatus: 'failed'` in an otherwise successful response, and Slack fallback may repair a receipt after dispatch rejection. Such outcomes set producer completion to false unless the route has positive evidence that it completed without admitting native work; conservative residual markers are preferable to invented success. Track every child effect in the admitted Slack branch, including reactions currently using `waitUntil`, setup-failure fallback, and the underlying acknowledgement post. `postWorkingAck` currently returns after a timeout while its network promise can still be running: add an optional `trackPost?: (promise: Promise<unknown>) => void` dependency invoked on the raw post promise before its catch/race, and pass `promise => scope.track(promise)` from admitted gateway calls. Keep the existing bounded ack wait; this change only retains producer ownership. Add a deferred ack timeout test proving the marker remains until the underlying promise settles, and a late rejection test proving it remains blocked. Wrap the fallback execution context's `waitUntil` to call `scope.track` before handing the promise to the real context. Do not count an already-caught promise as positive proof of a successful external effect. A child failure retains the marker conservatively. No control token is accepted from HTTP. `Retry-After: 60` may accompany unavailable responses, but text/docs do not claim buffering or guaranteed retry.

- [ ] **Step 4: GREEN and verification.** `npx tsx src/cutover/ingress.test.ts && npm run typecheck && npm test`. Expected exact signature/closed/deferred behavior passes and no existing auth regression. Ledger any preserved pre-existing error swallowing that makes a marker/product obligation ambiguous.

- [ ] **Step 5: Record local diff.** `git diff --check`; preserve all unrelated routes and behavior. No commit/merge.

### Task 3: Fence consuming crons without rejecting already-admitted reminder jobs

**Files:** Modify `src/cloudflare.ts`, `src/app.ts`, `src/config/deployment.test.ts`; create `src/gateway/scheduled-dispatch.ts`, `src/cutover/cron.test.ts`; modify `package.json` test chain.

**Consumes:** Task 1 producer scopes; existing `buildScheduledInput`, `claimEvent`, `bindingByProject`, `dispatchProject`.
**Produces:**

```ts
export interface ScheduledDispatchEnv extends Record<string, unknown> {
  DB?: D1Like;
  SLACK_EVENTS?: KVLike;
}
export function handleScheduledJob(env: ScheduledDispatchEnv, body: unknown):
  Promise<{ status: number; body: Record<string, unknown> }>;
```

This helper consumes an already-admitted job; it does not grant intake, authenticate callers, or register another producer. It still calls the existing current-tree `dispatchProject` with the exact input/idempotency shape. The beta counterpart uses beta's existing dispatch/input shape, not the native snapshot protocol.

- [ ] **Step 1: Write failing ordering tests.** Extend the actual scheduled wrapper VM fixture to use real admission helpers and deferred per-job handling. New tests:

```ts
const f = cronFixture({ state: 'closed' });
await f.fire('reminders');
await f.finish();
assert.equal(f.takeDueCalls, 0);
assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM reminders').get()!.n, 1);
```

Do not combine reminder and reconcile counters in one invocation: run separate named tests for each cron. Seed real due reminders and actual reflection/review watermark rows in SQLite. After a fenced reflection/review route, assert those rows are unchanged, not merely that a mock reported zero calls. The closed reconcile test starts from a durable queued coding run and asserts it can dispatch through a drain registration while replies recover independently. Open→closed race test holds the scan after admission but before it returns the one-shot, closes control, then resumes. Assert the one-shot dispatch succeeds exactly once under the original registration; no second `beginIntake` rejects it. Direct `/__internal/scheduled` remains blocked when closed. Test disabled/missing DB/control and unknown cron.

- [ ] **Step 2: Run RED.** `npx tsx src/cutover/cron.test.ts && npx tsx src/config/deployment.test.ts`. Expected pause tests fail because `takeDueReminders` currently runs before a route guard; race test exposes nested admission.

- [ ] **Step 3: Extract the existing per-job route body and integrate the scan scope.** Move body validation/claim/binding/input/dispatch logic from the current scheduled route into `handleScheduledJob`; retain identical status/body outcomes. Route authentication and intake remain in `src/app.ts`. The reminder scan obtains one intake registration before consuming reminders, then calls the helper directly for its already-admitted jobs:

```ts
const admission = await beginIntake(env, 'g2', 'reminder-scan');
const scope = createProducerScope(env, admission);
let succeeded = false;
try {
  const due = await takeDueReminders(env.DB!);
  for (const job of due) {
    const result = await handleScheduledJob(env, job);
    if (result.status >= 400) throw new Error('scheduled dispatch incomplete');
  }
  succeeded = true;
} finally {
  await scope.finish(succeeded);
}
```

No HTTP header or body can reuse a scope. Scope owns the full scan. Existing consuming one-shot failure behavior is not silently redesigned: if downstream admission/dispatch fails after deletion, preserve the marker and report a blocker for operator investigation.

Reflection/review acquire their scopes before taking any watermark batch. Reconcile route uses `beginDrain(...,'accepted-runs')` while handling the already-durable run backlog; scope covers that pass and notification delivery. Do not disable the entire reconciler. Reply capture/outbox finalization remain callable independently. Unknown cron stays a no-op; no generic heartbeat is reintroduced in native.

- [ ] **Step 4: GREEN and full suite.** `npx tsx src/cutover/cron.test.ts && npx tsx src/config/deployment.test.ts && npm run typecheck && npm test`. Assert the original open-mode cron route/input behavior remains equivalent except the deliberate in-process reminder helper change.

- [ ] **Step 5: Record evidence.** Ledger scan-before-consumption and race results; `git diff --check`. Keep local.

### Task 4: Pinned native observations without changing execution ownership

**Files:** Create `src/cutover/observation.ts`, `src/cutover/native-observation.ts`, `src/cutover/native-observation.test.ts`, `src/cutover/sdk-observation.ts`, `src/cutover/sdk-observation.test.ts`; modify `src/slack/reply-runtime.ts`, `src/slack/reply-runtime.test.ts`, and `package.json` test chain. Keep SDK logic versioned in one reader; the beta tree copies it without importing the native reader.

**Interfaces:** Task 6 consumes these exact types. `ObservationStatus` is defined here, not redefined in evidence.ts.

```ts
export type ObservationStatus = 'blocked' | 'unknown' | 'observed-idle';
export interface ObservationIdentity {
  namespaceId: string;
  objectId: string;
}
export interface ObservationSql {
  exec(query: string, ...bindings: unknown[]): {
    toArray(): Array<Record<string, unknown>>;
  };
}
export interface ObservationStorage {
  sql: ObservationSql;
  getAlarm(): Promise<number | null>;
  get<T>(key: string): Promise<T | undefined>;
}
export interface InstanceObservation extends ObservationIdentity {
  generation: 'g1' | 'g2';
  runtimeVersion: '1.0.0-beta.1' | '2.2.2';
  sdkVersion: '0.15.0' | '0.20.1';
  observedAt: number;
  format: { key: 'schema_version' | 'format_version'; value: string } | null;
  sdkSchemaVersion: string | null;
  status: ObservationStatus;
  nativeStatuses: Record<string, number>;
  sdkStatuses: Record<string, Record<string, number>>;
  counts: Record<string, number>;
  schedules: Array<{ callback: string; type: string; owner: string | null; count: number }>;
  alarm: number | null;
  blockers: string[];
  unknowns: string[];
  limitations: string[];
}
export interface SdkObservation {
  sdkSchemaVersion: string | null;
  sdkStatuses: Record<string, Record<string, number>>;
  counts: Record<string, number>;
  schedules: InstanceObservation['schedules'];
  blockers: string[];
  unknowns: string[];
}
export function readSdkObservation(sql: ObservationSql,
  version: '0.15.0' | '0.20.1'): SdkObservation;
export function readNativeObservation(storage: ObservationStorage,
  identity: ObservationIdentity, now?: number): Promise<InstanceObservation>;
// Extension RPC: observeCutover(identity: ObservationIdentity): Promise<InstanceObservation>
```

Namespace ID is supplied by authenticated routing and echoed, not discovered by the object. The extension must compare `identity.objectId` with `ctx.id.toString()` before reading. An observation's runtime version comes from its pinned implementation, not the request. Task 6 validates both the result and the request association. No diagnostic token or query payload becomes model input.

**Verified pinned evidence:** Native `@flue/runtime/dist/cloudflare/internal.mjs` prepares storage before the extension constructor. `sql-agent-execution-store-C0vwyWZB.mjs:737–760` defines the native table; its parser accepts queued/running/terminalizing/settled/joining/joined. Native `format-version-CbfgskCy.mjs` expects `format_version=1`, accepting only legacy `schema_version=8` during initialization. SDK resolution is **`@flue/vite/node_modules/agents@0.20.1`**, whose `dist/index.js:169–170` declares schema version11, not beta's version9. Store archive/file hashes in the execution ledger; exact internal filenames are compatibility evidence, not new public dependencies.

- [ ] **Step 1: Write reader failures with real SQLite and read-only statement capture.** Use the actual native operational DDL from the pinned package to form a test fixture, plus the exact SDK DDL/migrations captured from its installed source. Record fixture provenance/hashes; copying source DDL is a schema interpretation test, not actual SDK execution. Define test-only `nativeObservationFixture()` returning `{ sql, storage, seedSubmission(status), queries }` and `sdkObservationFixture(version: '0.15.0' | '0.20.1'): { sql: DatabaseSync; observationSql: ObservationSql }`. The SQL adapter records each executed statement and uses real `DatabaseSync` results. Read fixtures load DDL before query capture starts.

```ts
for (const state of ['queued', 'running', 'terminalizing', 'joining', 'joined']) {
  const f = nativeObservationFixture();
  f.seedSubmission(state);
  const result = await readNativeObservation(f.storage,
    { namespaceId: 'test-namespace', objectId: 'test-object' }, 10);
  assert.equal(result.status, 'blocked');
  assert.equal(result.nativeStatuses[state], 1);
  assert.ok(f.queries.every(q => /^(SELECT|PRAGMA)\b/i.test(q.trim())));
}
const f = nativeObservationFixture();
f.sql.exec("INSERT INTO cf_agents_fibers(fiber_id,name,status,created_at,completed_at) VALUES('f','x','completed',1,2)");
assert.equal((await readNativeObservation(f.storage,
  { namespaceId: 'test-namespace', objectId: 'test-object' }, 10)).status, 'observed-idle');
f.sql.exec("INSERT INTO cf_agents_runs(id,name,created_at) VALUES('r','x',1)");
assert.equal((await readNativeObservation(f.storage,
  { namespaceId: 'test-namespace', objectId: 'test-object' }, 10)).status, 'blocked');
```

Separate named tests cover: unknown native status; format missing/wrong/beta-only; required table/column missing; more than1000 rows with one unfinished row past the old listing cap; a joined follower without live host still blocks; settled row with missing settled_at is unknown; settled native error count is retained without returning error text; schedules in non-root owners; unknown/NULL callbacks/types; recurring callbacks; physical alarm with empty schedules; storage alarm/get failure; destroy-pending key; SDK version/schema mismatch; retained terminal fibers; pending/running fibers; legacy runs/facet references; queued SDK callbacks; workflow paused/waiting/unknown; interrupted child with `child_still_running=1` or NULL; detached terminal run whose `finish_delivered_at` is NULL. Prove no output includes payload/snapshot/error/metadata content. Each test changes one record/property.

- [ ] **Step 2: Run RED.** `npx tsx src/cutover/native-observation.test.ts && npx tsx src/cutover/sdk-observation.test.ts`. Make test scaffolding/imports valid, then record missing-observation/incorrect-classification failures. A missing module alone is not the behavioral RED.

- [ ] **Step 3: Implement guarded count readers.** Before each query, require the table and exact columns via `sqlite_master` and `pragma_table_info`. Use a fixed code-owned table allowlist, never interpolate request values. Native required columns: `submission_id,status,settled_at,error,canonical_ready_at,attempt_id,input_applied_at,abort_requested_at,started_at,joined_into,attempt_count,max_attempts,timeout_at,owner_id,lease_expires_at,settlement_record_id,settlement_record`; full table provenance above. Require `flue_meta` key `format_version` value `'1'`. Never invoke a native store initializer/list method to acquire data.

```sql
SELECT status,COUNT(*) AS count FROM flue_agent_submissions GROUP BY status;
SELECT COUNT(*) AS count FROM flue_agent_submissions
 WHERE status='settled' AND settled_at IS NULL;
SELECT COUNT(*) AS count FROM flue_agent_submissions
 WHERE status='settled' AND error IS NOT NULL;
SELECT state FROM cf_agents_state WHERE id='cf_schema_version';
SELECT COUNT(*) AS count FROM cf_agents_runs;
SELECT COUNT(*) AS count FROM cf_agents_facet_runs;
SELECT COUNT(*) AS count FROM cf_agents_queues;
SELECT status,COUNT(*) AS count FROM cf_agents_fibers GROUP BY status;
SELECT status,COUNT(*) AS count FROM cf_agents_workflows GROUP BY status;
SELECT status,COUNT(*) AS count FROM cf_agent_tool_runs GROUP BY status;
SELECT COUNT(*) AS count FROM cf_agent_tool_runs
 WHERE status='interrupted' AND (child_still_running IS NULL OR child_still_running<>0);
SELECT COUNT(*) AS count FROM cf_agent_tool_runs
 WHERE detached=1 AND finish_delivered_at IS NULL;
SELECT callback,type,owner_path_key,COUNT(*) AS count
 FROM cf_agents_schedules GROUP BY callback,type,owner_path_key;
```

SDK required tables/columns: `cf_agents_state(id,state)`, `cf_agents_runs(id,name)`, `cf_agents_facet_runs(owner_path,owner_path_key,run_id)`, `cf_agents_queues(id,callback)`, `cf_agents_fibers(fiber_id,status,completed_at)`, `cf_agents_workflows(id,status,completed_at)`, `cf_agent_tool_runs(run_id,status,child_still_running,completed_at)`, `cf_agents_schedules(id,callback,type,time,running,owner_path,owner_path_key)`. Native SDK0.20.1 additionally requires `detached,finish_claimed_at,finish_delivered_at,give_up_claimed_at,give_up_delivered_at` on tool runs. Its native outstanding detached predicate is `detached=1 AND finish_delivered_at IS NULL`; mirror it even for terminal status. A claimed finish is not delivered. Beta0.15.0 does not query those absent columns.

All rows in runs/facet-runs/queues are blockers: those are durable recovery references, not completed history. Known terminal fiber statuses are completed/aborted/interrupted/error; pending/running block, all other statuses unknown. Retained interrupted fibers are terminal records, not automatically a new native job; interrupted tool runs with unknown/live child remain unresolved. Tool starting/running block; completed/error/aborted and interrupted-with-confirmed-stopped-child are retained outcomes, with missing completion markers unknown. Workflow complete/errored/terminated are terminal; queued/running/paused/waiting/waitingForPause block; unknown/unrecognized status adds unknown. Count unsuccessful terminal outcomes for disposition, do not label them delivered answers.

Read every schedule owner. Any remaining schedule blocks observation, including recognized one-shot `__flueWakeAgentSubmissions`/`reconcileReplies`; those may clear naturally before a later observation. Cron/interval never count as idle. Unknown callbacks or malformed owners add unknown as well. Do not return schedule payloads or owner paths; aggregate by opaque owner key. Bound status/schedule group output to1000 groups plus an overflow sentinel, with independent uncapped total counts; overflow is unknown, never zero. Validate returned numeric counts and completion markers. Unknown reasons use fixed names, not database content. A failed schema/read returns explicit unknown rather than propagating sensitive runtime error text.

Read `storage.getAlarm()` and `storage.get('cf_agents_destroy_pending')` without writing. A surviving alarm/destroy marker blocks. Neither reader calls schedule, alarm, reconcile, abort, setName, setAlarm, deleteAlarm, or CREATE/UPDATE/DELETE. `status` is blocked if blockers exist, else unknown if unknowns exist, else observed-idle. Retain both reason arrays. Every observation discloses startup side effects and the absence of an atomic cross-storage/fleet snapshot.

- [ ] **Step 4: Add RPC to the existing native extension and test generated inheritance.** Preserve constructor/onStart/runFiber/reconcileReplies behavior. In the existing subclass add:

```ts
async observeCutover(identity: ObservationIdentity): Promise<InstanceObservation> {
  if (identity.objectId !== this.replyObjectId) throw new Error('object identity mismatch');
  return readNativeObservation(this.replyStorage, identity);
}
```

Capture `replyObjectId = ctx.id.toString()` in its existing constructor; import only observation types/reader. Extend the actual generated-class integration fixture in `reply-runtime.test.ts` to seed complete SDK schema plus read-only storage get/getAlarm methods for the diagnostic call. Assert inherited RPC returns g2 identity and rejects wrong ID; compare SQL/storage traces before/after the method body. This fixture's fake SDK is not physical-alarm proof. Existing actual native dispatch/join/abort/restart/reply tests still run unchanged.

- [ ] **Step 5: Verify native SDK wakes in an actual local runtime.** Create `scripts/cutover-native-canary.ts` and test-only `scripts/cutover-fixtures/native-entry.ts`. Import the actual emitted native `FlueProjectAgent` into that entry and subclass only to add `seedLocalWake()`, scheduling both `__flueWakeAgentSubmissions` and `reconcileReplies` with delay0. The local entry's fetch seeds a named local@g2 object only on `/seed`; all other requests call `observeCutover({ namespaceId:'local-only', objectId:id.toString() })`. As in the concrete beta entry below, setName is allowed for local canary birth only. No DB binding means reply reconciliation returns without external delivery. No native/model submission is manufactured. Use the native tree's installed Miniflare5.20260930.0-alpha with SQLite `TEST_AGENT`, all outbound requests rejected, no real credentials, and isolated temporary persistence. Poll local observations until schedules are empty and alarm NULL, then observe no rearm and reconstruct with the same local persistence to check matching-runtime startup. The script must exercise the actual SDK alarm, never call alarm directly or replace it with fake schedule removal. Add `test:cutover-native-canary` to package.json. A failed/unsupported harness blocks this gate; keep fake-SDK tests separately labeled.

```ts
const mf = new Miniflare({
  name: 'local-cutover-canary', modules: true, scriptPath: bundledEntry,
  compatibilityDate: '2026-09-30', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { TEST_AGENT: { className: 'LocalCanary', useSQLite: true } },
  durableObjectsPersist: temporaryPersistence,
  outboundService: () => { throw new Error('local canary forbids network'); },
});
try {
  assert.equal((await mf.dispatchFetch('http://local/seed')).status, 200);
  const deadline = Date.now() + 5000;
  let last: InstanceObservation;
  do {
    last = await (await mf.dispatchFetch('http://local/observe')).json() as InstanceObservation;
    if (last.schedules.length === 0 && last.alarm === null) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  assert.equal(last!.alarm, null);
  assert.equal(last!.schedules.length, 0);
  assert.equal(last!.status, 'observed-idle');
} finally { await mf.dispose(); }
```

`bundledEntry` and `temporaryPersistence` are paths created with `mkdtemp`, never a production Wrangler persistence directory. Bundle only the test entry plus the actual generated Worker artifact with esbuild, external cloudflare:*; resolve artifact main relative to its emitted config. Import Miniflare/esbuild from that tree's installed packages; no dependency upgrade. Wrap this first observation with another after1s and a second Miniflare constructed after disposal using the same temporary persistence. Clean up only after the reconstruction check. Report this as idle native/reply wake cleanup, not an interrupted attempt/model/delivery proof.

- [ ] **Step 6: GREEN and evidence.** Run both reader suites, `npx tsx src/slack/reply-runtime.test.ts`, typecheck, full suite, native build, and `npm run test:cutover-native-canary`. Expected complete counts, conservative classifications, no diagnostic-body writes, unchanged recovery behavior, actual SDK natural wake cleanup. Add test entries to npm test, run diff check, record actual results/hashes. No deployment or claimed fleet drain.

### Task 5: Separate beta bridge with supported diagnostics and natural-wake canary

**Files in beta worktree only:** Create `src/cutover/beta-observation.ts`, `src/cutover/beta-observation.test.ts`, `src/cutover/beta-runtime.ts`, `src/cutover/beta-runtime.test.ts`, `src/cutover/bridge.test.ts`, `scripts/cutover-beta-canary.ts`, and `scripts/cutover-fixtures/beta-entry.ts`; modify `.flue/agents/project.ts`, `.flue/app.ts`, `.flue/cloudflare.ts`, `wrangler.jsonc`, `package.json`. Copy runtime-neutral Task1 admission/producer/fixtures and Task4 observation/SDK reader files plus the reviewed additive0029–0032 migration files. The original baseline has only0029's predecessors; do not silently omit0029–0031 or change the pinned migration history. Do not copy the native Project, gateway snapshot protocol, reply outbox runtime, or dependency lockfile. Tasks6–7 later copy only their runtime-neutral reporting/config portions.

**Consumes:** Task1 admission/scopes and Task4 observation contracts/readSdkObservation. **Produces:** `betaRuntime` public extension; g1 `observeCutover(identity)` RPC; fence-integrated baseline-compatible bridge. Beta retains existing accepted-work tools and journal patch.

```ts
export function readBetaObservation(storage: ObservationStorage,
  identity: ObservationIdentity, now?: number): Promise<InstanceObservation>;
```

Import ObservationStorage/ObservationIdentity/InstanceObservation from the copied observation.ts contract, not a native runtime file.

**Exact verified extension seam:** Cached runtime1.0.0-beta.1 `dist/cloudflare/index.d.mts`/`index.mjs` export `extend`; `extension-COwOFIuV.d.mts:107–116` declares `base` and `wrap`. `extension-FmZ_1Ced.mjs:130–162` reads the agent module's **named `cloudflare` export** and validates the subclass from `base`; `wrap` accepts only identity/constructor proxy, not a subclass. Cached CLI1.0.0-beta.1 `dist/flue.js:332–357` generates `extends agentExtension.base(Agent)` and exports the wrapped generated class. Use **base only**. Runtime prepares storage before super/startup; this hook cannot make cross-runtime access safe.

- [ ] **Step 1: Prepare isolated baseline and establish its local baseline checks.** Use the worktree skill at execution, inspect/reuse/create the intended bridge tree as specified above. Run `npm ci --offline` there; if required cached dependencies are missing, record the missing package and stop that install rather than silently fetching/repinning. Existing postinstall applies the existing journal patch. Verify runtime/SDK/CLI1.0.0-beta.1, Agents0.15.0, patch bytes, and branch baseline against62beadc; run baseline typecheck/test/build. Do not call a baseline suite failure a hardening regression or hide it. All following commands run in that explicit beta worktree, not native.

- [ ] **Step 2: Write beta reader/extension failing tests.** Beta `sql-run-store-BJJC9Ukr.mjs:615–648` defines submissions, session deletions, attempt markers; `run-store-BoLOKXLD.mjs:220–230` stamps schema_version1. Test with exact pinned DDL and SDK0.15.0 schema9. Known native status vocabulary is queued/running/settled; queued/running block and any other status is unknown. Attempt/deletion markers independently block. A settled error contributes an unsuccessful-outcome count, never output error content.

```ts
const f = betaObservationFixture();
f.sql.exec("INSERT INTO flue_agent_attempt_markers VALUES('s','a',1)");
const result = await readBetaObservation(f.storage,
  { namespaceId: 'test-namespace', objectId: 'test-object' }, 10);
assert.equal(result.status, 'blocked');
assert.equal(result.counts.attemptMarkers, 1);
assert.ok(f.queries.every(q => /^(SELECT|PRAGMA)\b/i.test(q.trim())));
```

Separate tests: empty known beta schema; queued/running; settled timestamp missing; unfinished deletion; uncommitted journal; unknown journal phase/committed value; g2 format or mixed markers; schema/table/column missing; SDK9 versus11; retained completed fibers; legacy/facet/queue recovery; schedules in all owners and physical alarm; counts beyond listing caps; unknown callback/type; rejected identity; no reader-body mutations. Define `betaObservationFixture()` in test utilities with the same SQLite trace/storage contract as Task4, using only beta schema. Test `resolveCloudflareExtension({ cloudflare: betaRuntime }, 'project', 'Agent').base(TestBase)` with the actual pinned public/internal resolver and a minimal TestBase to prove inheritance; label this as composition proof, not full SDK behavior.

- [ ] **Step 3: Run RED.** `npx tsx src/cutover/beta-observation.test.ts && npx tsx src/cutover/beta-runtime.test.ts`. Record behavioral failures after valid scaffold. No beta schema is opened by native code.

- [ ] **Step 4: Implement beta count reader and base extension.** Require beta metadata schema_version1 and no conflicting format_version marker. Required submissions columns: `submission_id,status,settled_at,error,attempt_id,input_applied_at,recovery_requested_at,started_at,attempt_count,max_retry,timeout_at,owner_id,lease_expires_at`. Require `flue_agent_attempt_markers(submission_id,attempt_id,created_at)`, `flue_agent_session_deletions(session_key,started_at)`, and `flue_agent_turn_journals(submission_id,phase,committed,stream_consumed_at)`. Use:

```sql
SELECT status,COUNT(*) AS count FROM flue_agent_submissions GROUP BY status;
SELECT COUNT(*) AS count FROM flue_agent_attempt_markers;
SELECT COUNT(*) AS count FROM flue_agent_session_deletions;
SELECT phase,committed,COUNT(*) AS count FROM flue_agent_turn_journals GROUP BY phase,committed;
SELECT COUNT(*) AS count FROM flue_agent_turn_journals WHERE committed=0;
SELECT COUNT(*) AS count FROM flue_agent_submissions WHERE status='settled' AND settled_at IS NULL;
SELECT COUNT(*) AS count FROM flue_agent_submissions WHERE status='settled' AND error IS NOT NULL;
```

Uncommitted journals remain conservative blockers; allowed phases before_provider/provider_started/tool_request_recorded/committed must agree with committed0/1. Native settlement alone does not clear them by assumption. Read SDK with `readSdkObservation(sql,'0.15.0')`, expecting schema9. Reuse Task4 reason/output limits and alarm/destroy reads. Do not invoke store methods that reconcile malformed rows.

```ts
import { extend, type CloudflareAgentLike } from '@flue/runtime/cloudflare';
export const betaRuntime = extend<CloudflareAgentLike>({
  base: Base => class BetaCutoverAgent extends Base {
    private readonly cutoverStorage: DurableObjectStorage;
    private readonly cutoverObjectId: string;
    constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
      super(ctx, env);
      this.cutoverStorage = ctx.storage;
      this.cutoverObjectId = ctx.id.toString();
    }
    async observeCutover(identity: ObservationIdentity): Promise<InstanceObservation> {
      if (identity.objectId !== this.cutoverObjectId) throw new Error('object identity mismatch');
      return readBetaObservation(this.cutoverStorage, identity);
    }
  },
});
```

Import types/reader explicitly. In `.flue/agents/project.ts` add `export { betaRuntime as cloudflare } from '../../src/cutover/beta-runtime';`. Do not change its default createAgent or journal patch. Generated CLI retains Flue's native onStart/reconciliation.

- [ ] **Step 5: Write bridge producer/reaper failing tests before integrations.** `bridge.test.ts` loads real beta Hono/business modules with the same boundary-only VM strategy as Task2. Apply baseline migrations plus all reviewed additive0029–0032 to local SQLite. Assert closed signed Slack/Linear/scheduled/work-item/heartbeat/reflection/review does not consume claims/targets/transcripts/ack/watermarks. Test reminder open→closed race using a beta-specific per-job helper and original beta input shape. Verify callbacks and existing run notification recovery remain available.

```ts
const f = await betaIngressFixture({ control: 'closed' });
await f.internal('/__internal/agent-runs/reconcile', {});
assert.equal(f.reaperCalls, 0);
assert.equal(f.retryTurnCalls, 0);
assert.equal(f.bumpEpochCalls, 0);
assert.equal((await f.admin('/__admin/conversations/reset',
  { projectId: 'P', conversationId: 'C' })).status, 503);
assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM cutover_producers').get()!.n, 0);
```

That zero is asserted only for a fully successful empty drain pass; in a separate deferred accepted-run/parked-message test assert registrations remain while recovery promises run. Seed a real pending row and queued accepted run, then verify trusted recovery can progress while intake is closed. Failed/claimed parked rows remain evidence obligations; tests must not equate claim with final delivery. Test both ordinary absent-config behavior and invalid nonempty configuration suppression. Any enabled cutover mode suppresses the entire reaper, not only retry callbacks.

Run `npx tsx src/cutover/bridge.test.ts` for behavioral RED. Then transplant Task1–3 lifecycle rules to exact beta sites: Slack/observer registration in `.flue/app.ts`, raw Linear verification/deferred dispatch, authenticated scheduled/work-item, `/__heartbeat`, reflection/review, and reminder scan in `.flue/cloudflare.ts`. Observer callbacks stay under the original verified Slack scope. An accepted-run drain scope owns reconciliation+notification pass; a separate `parked-messages` drain scope owns `sweepPendingMessages` and deferred dispatch. Do not grant drain registration from a request body/header. Do not expand an intake scope from a public callback.

Replace the beta reaper call at `.flue/app.ts:348–354` with a mode guard; an absent setting alone permits old ordinary behavior. Invalid/nonempty mode never invokes reaper:

```ts
const reapedTurns = c.env.CUTOVER_CONTROL === undefined
  ? await reapStaleTurnActivities(db, c.env as Record<string, unknown>, {
      bumpEpoch: (projectId, conversationId) => bumpAgentEpoch(db, projectId, conversationId),
      retryTurn: row => retrySlackDoaTurn(db, c.env as Record<string, unknown>, row),
    }).catch(() => 0)
  : 0;
```

Keep the existing redacted catch logging if retained; the guard encloses the entire call, not just retry callbacks. Authenticated manual epoch-reset returns503 before bump while any cutover mode is configured:

```ts
if (!requireAdmin(c)) return c.body(null, 404);
if (c.env.CUTOVER_CONTROL !== undefined) {
  return c.json({ error: 'session reset unavailable during cutover' }, 503);
}
```

Add `CUTOVER_CONTROL?: unknown` to the beta Env type. Use the same undefined-only configuration interpretation as Task1; empty/null values fail closed, not ordinary behavior. No call to `retrySlackDoaTurn` is used to empty the backlog. Keep its existing ordinary callers, not a new runtime patch. Preserve beta heartbeat cron mapping in ordinary mode; it is fenced in bridge mode.

- [ ] **Step 6: Build an actual pinned beta/SDK local natural-wake canary.** Reader fixtures and fake SDK tests are insufficient. Add a test-only entry extending the CLI's actual built `FlueProjectAgent` export. Its only new method seeds a **local** native wake via SDK `schedule(0, '__flueWakeAgentSubmissions', undefined, { idempotent: true })`; it never overrides alarm or deletes storage. Test entry is excluded from deployed imports and normal production tsconfig discovery/build scanning. Use a script under scripts, or `.test.ts` fixture naming if necessary, and verify emitted production entry does not include it.

```ts
// Test-only entry bundled by the local harness, never exported by production.
export class LocalCanary extends GeneratedFlueProjectAgent {
  async seedLocalWake(): Promise<void> {
    await this.schedule(0, '__flueWakeAgentSubmissions', undefined, { idempotent: true });
  }
}
export default { async fetch(request: Request, env: { TEST_AGENT: DurableObjectNamespace }) {
  const name = 'project:local-cutover:agent:default/conv:local@g1';
  const id = env.TEST_AGENT.idFromName(name);
  const stub = env.TEST_AGENT.get(id) as unknown as {
    setName(name: string): Promise<void>;
    seedLocalWake(): Promise<void>;
    observeCutover(identity: ObservationIdentity): Promise<InstanceObservation>;
  };
  if (new URL(request.url).pathname === '/seed') {
    await stub.setName(name); // local canary birth only; never in production diagnostics
    await stub.seedLocalWake();
    return new Response('seeded');
  }
  return Response.json(await stub.observeCutover({ namespaceId: 'local-only', objectId: id.toString() }));
} };
```

`GeneratedFlueProjectAgent` imports the generated artifact's real class. The runner reads that tree's emitted `dist/hatchery/wrangler.json` to resolve its actual main path; no guessed `.flue` filename. Bundle the test entry with the installed esbuild, `platform:'neutral', format:'esm', bundle:true`, external `cloudflare:*`, then instantiate that tree's installed Miniflare with SQLite `TEST_AGENT: { className:'LocalCanary', useSQLite:true }`, fake-only bindings and persistence in a new temporary directory. Bindings omit ZAI/Slack/runner credentials. An outbound-service double throws on every network request. Resolve Miniflare options from that installed version's definitions, not the native tree's version; no production namespace IDs/config copied into local bindings.

The script calls only `mf.dispatchFetch('http://local/seed')` then local observation, polls at250ms up to5s for SDK one-shot removal and physical alarm NULL, then verifies no rearm over another1s and after disposing/reconstructing Miniflare against the same temporary local persistence. Cached beta Miniflare4.20260609.0 exposes getDurableObjectNamespace/dispatchFetch, not the native version's unsafeEvictDurableObject API; use full local reconstruction rather than assuming that API exists. Record exact SDK/runtime identities and before/after counts. Finally dispose Miniflare and remove only its newly created local temporary directory. Never call alarm/wake RPC as a production status endpoint. Timeout/non-null alarm is a failed check, not permission to delete it. If installed Miniflare cannot run the generated module/eviction API, record a blocked canary and stop that gate; do not substitute fake alarm execution. Expose `npm run test:cutover-beta-canary` invoking `tsx scripts/cutover-beta-canary.ts`; run it separately from fast unit tests. This idle-wake canary proves native callback/SDK cleanup locally, not previously-running attempt crash recovery or fleet drain.

- [ ] **Step 7: GREEN and baseline compatibility gates.** Run all new beta suites and copied admission/SDK tests, beta typecheck/full suite/build, actual local canary, and diff check. Hash dependencies/patch and compare with baseline. Apply reviewed additive0029–0032 to baseline-shaped SQLite, rerun baseline product tests, and confirm the new initially-closed control row. Keep synthetic schema, generated composition, actual SDK alarm, and production-unverified evidence distinct. No native dependency downgrade or bridge deployment.


### Task 6: Authenticated observations and offline evidence report

**Files:** Create `src/cutover/diagnostics.ts`, `src/cutover/diagnostics.test.ts`, `src/cutover/evidence.ts`, `src/cutover/evidence.test.ts`, `scripts/cutover-report.ts`; modify `src/app.ts`, `package.json`; copy runtime-neutral files to the beta bridge in this task, after Task 5 establishes its runtime reader. Tasks 4–5 above define the observation contract.

**Consumes:** Native/beta observation contracts from Tasks 4–5, Task 1 control and producer schema.
**Produces:** Authenticated `/__admin/cutover/status`, `/__admin/cutover/admissions`, `/__admin/cutover/instance` routes; offline evidence evaluation. No public stream/read API or native wake API is added.

```ts
// Import ObservationStatus, InstanceObservation, ObservationIdentity from './observation'
// and Generation from './admissions'; do not redeclare the shared observation types.
export interface InventoryEntry {
  namespaceId: string;
  objectId: string;
  generation: Generation;
  runtimeVersion: '1.0.0-beta.1' | '2.2.2';
  associationEvidence: string;
  instanceName?: string;
}
export interface NamespaceListing {
  namespaceId: string;
  observedAt: number;
  paginationComplete: boolean;
  objects: Array<{ id: string; hasStoredData?: boolean }>;
}
export interface CoverageEvidence {
  listing: NamespaceListing;
  previousListing: NamespaceListing | null;
  inventory: InventoryEntry[];
  observations: InstanceObservation[];
  producerCount: number;
  controlState: 'open' | 'closed' | 'unknown';
  closedAt: number | null;
  productCounts: Record<string, number>;
  unknowns: string[];
  preBridgeRetirementEvidence: string | null;
  controlObservedAt: number;
  producersObservedAt: number;
  productObservedAt: number;
  lastProducerFinishedAt: number | null; // supplied evidence, not inferred from deleted rows
  deliveryDispositionEvidence: string | null;
  observationTimingEvidence: string | null;
}
export interface CutoverReport {
  status: ObservationStatus;
  blockers: string[];
  unknowns: string[];
  coverage: { listed: number; associated: number; observed: number };
  limitations: string[];
}
export function evaluateCutoverEvidence(input: CoverageEvidence, now?: number): CutoverReport;
```

Evaluator core keeps all reasons and does not conflate observation with authorization:

```ts
const blockers: string[] = [];
const unknowns = [...input.unknowns];
if (input.controlState === 'open') blockers.push('admissions open');
if (input.controlState === 'unknown') unknowns.push('admission control unavailable');
if (input.producerCount > 0) blockers.push('producer operations outstanding');
for (const [name, count] of Object.entries(input.productCounts)) {
  if (count > 0) blockers.push(`product obligation: ${name}`);
}
for (const observation of input.observations) {
  blockers.push(...observation.blockers);
  unknowns.push(...observation.unknowns);
}
const status: ObservationStatus = blockers.length ? 'blocked'
  : unknowns.length ? 'unknown' : 'observed-idle';
```

Coverage/timestamp/version validation adds reasons before calculating status. Only blocker-category counts enter `productCounts`; informational backlog and terminal outcome counts remain in the status endpoint's separate fields, not accidental blockers. Require all expected keys even when zero: both runtimes require `pendingMessages`, `activeReceipts`, `agentRuns`, `workRuns`, and `notifications`; g2 additionally requires `replyOutbox` and `replyTrackers`. An empty map or omitted key adds unknown rather than passing. Determine required generations from the inventory/observations and reject an unsupported mix; every generation's counts are explicit, with keys prefixed `g1.`/`g2.` when both are included. A missing required table/column yields unknown, never an inserted zero. `idleFixture()` must supply one fully listed g2 object, two matching complete listings, a matching known-format idle observation, closed control, zero complete product counts, post-producer timestamps, and nonempty explicitly labeled test evidence strings. Each test mutates one literal field.

Strict parse external JSON before evaluation. Reject unexpected runtime/version combinations, nonfinite/negative counts/timestamps, duplicate object IDs, mismatched namespaces, contradictory entries, and missing observation coverage. Association evidence is a recorded human/source justification, not proof generated by the tool. Do not let an empty arbitrary string act as evidence. Require current and previous full listings to share the same namespace/ID set; missing comparison or a changing set reports unknown. Require control/producers/product observations and the current listing, as well as every native observation, to postdate the last producer-finished timestamp and the recorded closure boundary; add `closedAt: number | null` to CoverageEvidence and require it for closed-state evidence. Future timestamps beyond the evaluation clock and out-of-order previous/current listings are invalid. Test each stale timestamp independently. Require explicit timing evidence when no last-producer timestamp is known; do not make a snapshot taken before the last admitted operation count as idle evidence. `deliveryDispositionEvidence` covers beta claimed parked rows and failed terminal effects not explained by status counts. Reports retain the limitation that submitted evidence is not independently authenticated by this offline tool.

- [ ] **Step 1: Write failing routing/coverage tests.** Namespace spy throws if contacted. Verify a beta entry sent to g2 diagnostics is rejected before `idFromString`, `get`, RPC, or `setName`; unauthenticated requests remain 404. Verify a same-runtime name/id pair is validated with pure `idFromName` derivation, then uses `idFromString` for the diagnostic stub without bootstrap. A mismatched name/id pair and an opaque unverified association return unknown without contacting an object.

```ts
const report = evaluateCutoverEvidence({ ...idleFixture(), listing: {
  namespaceId: 'test-namespace', observedAt: 10, paginationComplete: false, objects: []
} });
assert.equal(report.status, 'unknown');
assert.ok(report.unknowns.some(x => x.includes('pagination')));
assert.equal(evaluateCutoverEvidence({ ...idleFixture(), producerCount: 1 }).status, 'blocked');
assert.equal(evaluateCutoverEvidence({ ...idleFixture(), controlState: 'open' }).status, 'blocked');
assert.equal(evaluateCutoverEvidence({ ...idleFixture(), preBridgeRetirementEvidence: null }).status, 'unknown');
```

Further cases: stored/unclassified object; missing `hasStoredData`; listing changes between supplied observations; missing RPC; unknown schema; g2 work under beta rollback evidence; old pending messages; terminal receipt with incomplete chrome; `uncertain` outbox; waiting-human/approval coding run; pending work run; failed notification; absent required product table; numeric/string NaN; empty inventory with a nonempty fleet; truncated lists and duplicate IDs. `blocked` may win when a real blocker and unknown coexist, but both arrays must be retained.

- [ ] **Step 2: Run RED.** `npx tsx src/cutover/diagnostics.test.ts && npx tsx src/cutover/evidence.test.ts`. First make imports valid, then observe behavior failures for coverage and mismatch; retain no inferred pass.

- [ ] **Step 3: Add authenticated routes and offline evaluator.** Use existing `requireAdmin`, never the heartbeat or runner token. Admission control POST accepts only `{ state: 'open' | 'closed', expectedRevision: number }`; invalid input 400, stale revision 409, schema/control error 503. The mutation route is code only: do not invoke it remotely in this plan.

Diagnostic entry validation precedes object contact. Pin the deployed binding's namespace ID in reviewed diagnostic configuration (`CUTOVER_NAMESPACE_ID`, a nonsecret Worker var); add it to Env/config guard/documentation for both artifacts. The route requires this setting and compares entry.namespaceId with it before selecting the fixed FLUE_PROJECT_AGENT binding; absent/mismatched configuration returns unknown without namespace access. Build guard validates the var against the recorded preflight namespace identity `1d642bbe6aff4936be41d7cccac2dd5c` (current-version.json maps it to FLUE_PROJECT_AGENT/FlueProjectAgent), not a caller-supplied expected value. Use that exact nonsecret value in both fenced artifact configurations; future target changes require a reviewed guard/config update. Local fixtures use a fake test namespace. No generic binding name is accepted from the request. Do not trust a caller's generation label or `associationEvidence` string as a storage-format guarantee. For current named instances, require the supplied `instanceName` to end in the expected `@g1`/`@g2`, derive its ID with the namespace's pure `idFromName`, and compare it with supplied object ID before `get`/RPC. This is identity derivation, not instance initialization. For legacy/opaque IDs without a validated named identity, return unknown unless a reviewed runtime-specific association mapping is available in the deployed diagnostic configuration; this plan adds no generic arbitrary-ID inspection bypass. A name/id pair inconsistent with the claimed runtime is rejected. Route calls only `observeCutover({ namespaceId: entry.namespaceId, objectId: entry.objectId })` on an already-associated object, without `setName`; on inaccessible/missing RPC return unknown. Timeouts do not declare idle and do not cancel native work. This access may cause matching-runtime startup; expose that in the response limitations.

Status reads control/producer count and complete aggregate counts from existing tables. Required SQL predicates:

```sql
SELECT COUNT(*) AS n FROM cutover_producers;
SELECT COUNT(*) AS n FROM pending_messages WHERE status='pending';
SELECT COUNT(*) AS n FROM slack_turn_activity WHERE status='active';
SELECT COUNT(*) AS n FROM agent_runs
 WHERE status NOT IN ('completed','failed','cancelled');
SELECT COUNT(*) AS n FROM work_runs
 WHERE status NOT IN ('completed','failed','cancelled');
SELECT COUNT(*) AS n FROM agent_run_notifications WHERE status<>'sent';
SELECT COUNT(*) AS n FROM slack_reply_outbox WHERE status<>'sent';
SELECT COUNT(*) AS n FROM slack_reply_trackers
 WHERE status IN ('pending','staged') OR receipt_completed_at IS NULL;
```

The final two tables are required for g2 only; beta absence is expected and explicitly versioned, not silently treated as empty g2 delivery. `work_items` remain product backlog, not an automatic execution blocker unless associated with unfinished `work_runs`; report their status counts separately. Unexpected row statuses, missing columns, and unsupported versions are unknown. Claimed beta parked-message rows need independent settlement/delivery evidence; a status change alone is not completion. Failed/cancelled native outcomes require disposition evidence, not an invented successful answer.

Use primary-bound D1 reads without Sessions to avoid stale replica zero counts. These reads are not a transaction-wide native/D1 snapshot; include timestamps and that limitation. A report never includes request bodies, transcript text, tokens, or model content.

Offline command reads only explicit local input files and emits the report:

```sh
npx tsx scripts/cutover-report.ts --input ./evidence.json
```

No default production URL, API token lookup, Slack request, object listing request, or deploy command. Exit 0 for coverage-qualified observed-idle, 2 for blocked/unknown, 1 for invalid input. Output always says `observed-idle is not deployment or rollback authorization`.

- [ ] **Step 4: GREEN and suite.** Run both test files, typecheck, full native suite; run the copied route/evidence tests in the beta bridge too. Test the offline CLI using temporary fabricated local fixtures labeled test data, checking exit codes and zero network use.

- [ ] **Step 5: Record limits.** Ledger runtime mismatch/no-access assertion, coverage failures, and product counts. Keep local; no production observation is implied.

### Task 7: Slack metadata contract and operational checklist

**Files:** Modify `slack-app.manifest.json`, `src/slack/reconcile-post.test.ts`, `docs/deployment.md`, `vite.config.ts`, `src/config/deployment.test.ts`, and only the misleading rollback comment in `.github/workflows/deploy.yml`; create `scripts/check-cutover-config.ts`, `src/cutover/config.test.ts`, `src/slack/test-data/manifest-before-cutover.json`; modify `.env.deploy.example` to document the optional ordinary-deployment setting without enabling it globally. Add the config test to `npm test`.

**Consumes:** All preceding task behavior; existing `postMessage`/`findPostedReply`; both generated Worker configurations.
**Produces:** Additive manifest registration, an administrator-ready patch, explicit bridge/cutover artifact guard and operator checklist. Do not alter live app configuration.

- [ ] **Step 1: Write failing metadata/config tests.** Extend `reconcile-post.test.ts` to derive the event type from the real outbound request, then require a matching registration:

```ts
const manifest = JSON.parse(readFileSync(new URL('../../slack-app.manifest.json', import.meta.url), 'utf8'));
const registrations = manifest.metadata?.event_subscriptions ?? [];
await postMessage('test-token', 'test-channel', 'answer', 'thread', { deliveryId: 'd' });
const outgoing = body.metadata as { event_type: string; event_payload: { delivery_id: string } };
assert.equal(outgoing.event_type, 'morehands_reply');
assert.equal(registrations.filter((r: { event_type: string }) => r.event_type === outgoing.event_type).length, 1);
assert.equal(outgoing.event_payload.delivery_id, 'd');
```

Supply a metadata-bearing history response from that captured payload and assert `findPostedReply` returns its timestamp. Separate tests assert wrong event type, wrong delivery ID, absent metadata, and unavailable history do not authorize a fresh post. Snapshot/compare all unrelated manifest keys before/after removing `metadata`; use baseline fixture JSON in test data, not a test that blesses the new file itself.

Configuration tests reject fenced artifacts missing `CUTOVER_CONTROL=d1`, invalid values, any new class deletion/migration tag, altered namespace binding identity, native dependency regression, and bridge patch removal. Fake guard inputs derive from checked local generated config fixtures with nonsecret test IDs; mutate one safety property at a time and assert nonzero CLI exit. Compare migration arrays to reviewed baseline fixtures, not a blanket ban on historical `deleted_classes` (the established flue-011 tag deliberately deleted the old Project class). Ordinary mode may stay unconfigured. Verify guard inspects emitted config, not only source text.

- [ ] **Step 2: Run RED.** `npx tsx src/slack/reconcile-post.test.ts && npx tsx src/cutover/config.test.ts`. Expected missing metadata registration and missing guard failures; fix scaffolding errors before claiming behavioral RED.

- [ ] **Step 3: Add the minimal manifest block.** No event-type constant renaming or unrelated scopes:

```json
"metadata": {
  "event_subscriptions": [
    { "event_type": "morehands_reply", "schema": {} }
  ]
}
```

Document that app administrators merge just this block into the installed manifest, preserving actual URLs/scopes/settings. Live manifest validation and metadata retention require later authorization. No absent history match permits reposting.

Implement a local guard invoked as:

```sh
npx tsx scripts/check-cutover-config.ts --mode fenced --runtime 2.2.2 --config dist/hatchery/wrangler.json
```

The bridge uses `--runtime 1.0.0-beta.1`. Require emitted `vars.CUTOVER_CONTROL==='d1'`, historical tags, expected class/binding names, and no namespace deletion. The ordinary build remains available; an ordinary artifact cannot be promoted as a fenced artifact. For native, wrap the existing public config customizer; do not select a new named Cloudflare environment, which could change Worker/namespace identity:

```ts
export default defineConfig(() => {
  const fluePlugin = flue();
  const customize = flueWorkerConfig();
  return { plugins: [fluePlugin, cloudflare({ config(config) {
    customize(config);
    if (process.env.MOREHANDS_BUILD_CUTOVER === 'fenced') {
      config.vars = { ...config.vars, CUTOVER_CONTROL: 'd1',
        CUTOVER_NAMESPACE_ID: '1d642bbe6aff4936be41d7cccac2dd5c' };
    } else if (process.env.MOREHANDS_BUILD_CUTOVER) {
      throw new Error('Invalid cutover build mode');
    }
  } })] };
});
```

Build with `MOREHANDS_BUILD_CUTOVER=fenced npm run build`, inspect the actual emitted config, and run the guard. Update the existing deployment test to exercise this customizer behavior rather than retaining its exact-source regex. The beta artifact step uses its existing authored config with `vars.CUTOVER_CONTROL='d1'` and `vars.CUTOVER_NAMESPACE_ID='1d642bbe6aff4936be41d7cccac2dd5c'` and verifies the beta builder preserves both; no lifecycle environment or renamed Worker. Do not deploy to test either guard. If tooling omits the variable, fail rather than accepting an unverified source flag.

- [ ] **Step 4: Replace the vague cutover checklist with exact staged gates.** Operational order:

1. Identify the exact deployed source/dependencies/patch; baseline62beadc is only a candidate until verified. Identify all prior generations stored in the namespace; unassociated objects block coverage.
2. Announce a quiet window and suspend upstream work creation. Rejected HTTP events are not durably buffered; collect provider rejection/retry evidence without logging payloads/secrets. Never claim a fixed waiting interval retires pre-bridge producers.
3. With separate authorization, back up D1 and apply reviewed additive control schema **before bridge code requires it**. A migration file named0032 does not mean older unapplied0029–0031 may be skipped blindly. To keep one migration history, review/apply all pending additive migrations in order, under beta compatibility checks. Do not directly execute0032 and later mark it applied by hand.
4. Separately authorize bridge deployment; no lifecycle namespace changes. Keep control initially closed. Establish old-bundle retirement and let accepted work drain. If evidence cannot establish retirement/coverage, hold; no abort/alarm deletion.
5. Observe registrations, parked work, beta state/schedules/alarms, coding/work runs, and external delivery evidence. Preserve claimed-message ambiguity and unresolved receipts. Capture fully paginated namespace listing separately; no auto-run network script in this plan.
6. Separately authorize native deployment with fence retained closed, after guards/checks and completed evidence review. Do not inspect beta objects via g2. D1 backup does not restore DO state.
7. App administrator merges/validates Slack manifest patch. Explicitly authorize a private `#test` canary using only flash. Since control is global, temporarily opening it is allowed only after upstream quiet-window conditions are established; it does not create a channel bypass. Close again before evidence review if needed.
8. Reopen only with explicit authorization and reconcile rejected events deliberately. Before g2 activity, bridge rollback is conditional; after g2 activity, finish g2 work/delivery/schedules under g2 before considering beta. Prefer forward repair if that boundary cannot be proved. Never restore D1 while native/runner work can still write.

State that the current CI push-to-main deploys Worker and may deploy Trigger.dev due to package-lock changes. Do not push. Correct the nearby CI comment that calls code rollback generally reversible if it would conflict with the newly documented native format limits; no unrelated CI restructuring.

- [ ] **Step 5: GREEN and final exact-tree gates.** On native: `npm run typecheck`, `npm test`, `npm run build`, config guard for the prepared fenced artifact, `npx wrangler deploy --config dist/hatchery/wrangler.json --dry-run`, and `git diff --check`. On bridge: the corresponding pinned typecheck, complete test suite, beta build, fenced guard, nonpublishing dry-run, patch/dependency hashes, and diff check. No real model/Slack calls. Record known warnings and every failed/skipped check honestly.

- [ ] **Step 6: Whole-change review and handoff.** One independent OpenAI/opencodex reviewer reads both change sets, the approved spec, plan, ledger rulings, exact dependency/patch/config evidence, and Review Focus. Verify important findings with failing tests and one fix pass, then rerun both final gates. Report missing actual-native crash/alarm/production proofs separately; do not convert synthetic records into those proofs. Keep both worktrees and all evidence; no commit/merge/push/deploy without explicit authorization.

## Plan self-review and authorization handoff

| Approved design requirement | Owning task / verifiable gate |
|---|---|
| Atomic shared fence, fail closed, no expiry/replay | Task1 SQL ordering and lifetime tests |
| Verified HTTP producers, underlying/deferred promises | Task2 real-route and deferred ack/Linear tests |
| Consuming scans and already-admitted reminder race | Task3 real watermark/reminder ordering tests |
| Matching native runtime, full status/SDK counts | Task4 guarded readers, generated RPC, actual local SDK canary |
| Separate compatible beta bridge and accepted drain | Task5 baseline pins/patch, complete reaper/reset suppression, beta canary |
| Inventory/runtime association, incomplete coverage | Task6 pre-contact routing and offline coverage/timing tests |
| External obligations, no blind post retry | Tasks6–7 delivery counts/disposition and exact metadata reconciliation |
| Additive installed-manifest patch without replacement | Task7 manifest preservation regression and admin-only procedure |
| Backup/migration order and rollback boundaries | Task7 staged operational gates, no remote execution |
| Fresh verification on each artifact and independent review | Task7 both exact-tree gates and one OpenAI review |

Planning source checks established beta's public base extension and generated-class composition, the two SDK schemas (beta9/native11), and actual pinned local-harness availability. They did **not** run either canary, implement any source change, test producer behavior, or certify production compatibility/drain. All task checkboxes remain unchecked intentionally.

The backup/ordered-additive-migration gate precedes bridge deployment because the bridge needs the control table. This corrects the initial draft's ordering; no backup or migration has been executed. The bridge baseline remains a candidate until deployed source/dependency identity is established.

Recommended execution: **Native** implementation in this session with one fresh OpenAI whole-change review, because the seven tasks share admission/observation contracts and coordinated beta/native fixtures. Subagent-driven implementation is an alternative if per-task independent review is preferred, at higher fresh-context cost. This is a recommendation, not a recorded user selection. Implementation waits for review/approval of this completed plan and an execution-method selection; neither deployment nor integration is included.
