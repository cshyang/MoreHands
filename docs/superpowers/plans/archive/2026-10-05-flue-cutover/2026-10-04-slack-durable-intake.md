# Durable Slack Intake Implementation Plan

**Status:** Human approved the reviewed plan and local inline execution on 2026-10-04 (approved SHA256 `a6dd0f90df8a8bc670b782ff738e6567d3ffc15cfee8d2402e5666a7c246766e`). One independent implementation review and its single fix pass are complete. All three Important findings are fixed locally, including the reconciliation-budget adjustment approved on 2026-10-05. Fresh final local gates pass with 1167tests/0failures and an exact fenced artifact recorded in `reconciliation-budget-final-gates.json`. Remote probe implementation/capacity proof and production migration/deployment/reopening remain separately gated; this plan stays active.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durably accept verified Slack work before acknowledgement, preserve the exact native request across ambiguous handoff, and recover transport preparation without replacing native Flue execution.

**Architecture:** A product-owned D1 inbox registers producer ownership atomically and retains asynchronous preparation state. Bounded D1 chunks hold an immutable native request; an existing cron backstop resumes preparation or exact keyed dispatch. Flue owns all model execution, joining, canonical history and agent recovery; the current uncertainty-aware answer outbox remains unchanged.

**Tech Stack:** TypeScript, Hono, Cloudflare D1, native Flue runtime/Vite 2.2.2, SQLite test adapters, emitted Worker/Miniflare proofs, existing Slack metadata/history APIs.

**Spec:** `docs/superpowers/specs/2026-10-04-slack-durable-intake-design.md` (human approved for planning on 2026-10-04).

## Global Constraints

- Implementation and production migration are not approved by planning approval. Written plan review and execution selection precede product edits.
- Native Flue remains the only model execution, joining and recovery engine. No native alarm overrides or direct native-submission writes.
- ONLY use GLM-5.3-flash for authorized live model checks. Local fake-provider tests also assert `zai/glm-5.3-flash` / `glm-5.3-flash`.
- Never push. Do not commit automatically. Keep current worktree `flue-2-spike`, existing modifications and both evidence workspaces.
- No new R2/Cloudflare Queue binding or dependency. D1 chunk storage requires actual binding/capacity evidence before production promotion.
- No resolved credential, bearer header or private Slack download URL in persisted payloads/logs/model content.
- At most 1,000,000 bytes per prepared-request BLOB chunk. Existing 11,500,000-byte native application bound and 4096-byte reserve remain unchanged.
- HTTP 200 follows positive durable event acceptance, not KV claim, `waitUntil`, media download or guessed native receipt.
- Matching duplicates may recover existing acceptance under closed intake; closed intake rejects new work. Never recreate producer ownership on duplicate.
- Freeze before first native dispatch; ambiguous retry uses exactly the same target/epoch/message/attachments/initialData/key via top-level dispatch.
- No automatic retry of ambiguous Slack acknowledgement or answer posting. Positive metadata matching repairs known intent; absence is not repost permission.
- Failures/corruption/conflicts remain visible and block cutover until positively resolved or explicitly dispositioned.
- Reflection bug repair and historical bare-image disposition are separate, not silently included. Exact two-marker reconciliation was separately approved/executed; do not replay it.
- Archive linked plans only after verified production completion, not after local test success.
- Subagents, when authorized, use OpenAI or ZAI through opencodex by default. The human separately authorized `devin/claude-sonnet-5-5` through opencodex for review on 2026-10-04. This is the named review exception to the earlier model restriction. Set every model explicitly; review completion does not grant human approval. Live MoreHands canaries remain GLM-5.3-flash only.

## Review Focus

- Event retry after a lost acceptance response, including closed-fence retry and changed payload: one durable event/producer, no suppressed unknown work (Task 1/4).
- Stale preparation worker after lease expiry: no replacement frozen request, duplicate acknowledgment or dispatch (Tasks 2/3/5).
- 11 MB images and Unicode across chunk boundaries: exact bytes, bounded BLOB/query budgets, no partial readiness (Tasks 2/6).
- Working acknowledgement accepted by Slack but response lost: positive metadata repair, never a second post or borrowed timestamp (Tasks 3/6).
- Crash after native acceptance before receipt/tracker storage: exact replay and trusted association, no additional execution or early producer release (Tasks 5/6).

---

## File Responsibilities

| File | Responsibility |
|---|---|
| `migrations/0033_slack_ingress.sql` | Additive inbox/manifest/chunk schema and atomic producer trigger |
| `src/slack/ingress-store.ts` | Unique acceptance, CAS leases, retained states, publication and receipt ownership |
| `src/slack/frozen-request.ts` | Exact request byte encoding, chunk storage/validation and manifest publication |
| `src/slack/ingress-cleanup.ts` | Bounded deletion of abandoned, unreferenced attempts under the retention rules below |
| `src/slack/ingress-ack.ts` | Persisted working-ack intent and uncertainty-aware metadata repair |
| `src/slack/accepted-event.ts` | Extract existing verified-event business preparation, preserving ambient/engaged behavior |
| `src/gateway/slack-ingress.ts` | Recover accepted transport work, prepare once and hand off exact native request |
| `src/gateway/dispatch.ts` | Separate preparation from native admission; retain existing caller API |
| `src/app.ts` | Signature verification plus durable accept/HTTP response and guarded internal recovery route |
| `src/cloudflare.ts` | Existing cron backstop invokes ingress recovery; no new agent scheduler |
| `src/cutover/diagnostics.ts`, `evidence.ts` | Inbox obligations and fail-closed coverage under new schema |
| `scripts/ingress-fixtures/`, `scripts/native-ingress-proof.ts` | Emitted native crash/replay/large-payload proof, no production fixture routes |
| `scripts/d1-ingress-storage-proof.ts` | Explicit isolated-storage capacity gate; no production target default |

New test files use the existing `createTestRunner` pattern. Add them explicitly to the project's `npm test` command; current runner does not discover files automatically. Base the SQL helper on `src/cutover/test-fixtures.ts:sqliteD1` and the migration loader in `src/cutover/ingress-test-fixture.ts`. The inline adapter in `threads.test.ts` is only a BLOB-binding example. Local schema tests use `node:sqlite` and a test-only D1 adapter that executes bound BLOB values and transactional batches against actual SQL. No test utilities enter production classes.

## Shared Interfaces

```ts
// ingress-store.ts
import type { D1Like } from '../skills/repository';
import type { ConversationTarget } from '../project/conversations';
import type { Persona } from '../project/persona';
import type { Binding } from '../project/bindings';
import type { AgentDispatchRequest, DispatchReceipt } from '@flue/runtime';
import type { ProjectDispatchRequest } from '../gateway/dispatch-message';
import type { SlackEventEnvelope, SlackUserMessageEvent } from './events';
export type BoundD1Statement = ReturnType<ReturnType<D1Like['prepare']>['bind']>;
export interface IngressDb extends D1Like {
  batch(statements: BoundD1Statement[]): Promise<Array<{
    success: boolean; meta?: { changes?: number }; results?: unknown[];
  }>>;
}
export type IngressState = 'received' | 'preparing' | 'ready' | 'uncertain' | 'accepted' | 'failed';
export interface VerifiedIngressEvent {
  key: string; teamId: string; eventId: string; digest: string; eventJson: string;
}
export type IngressAcceptance =
  | { status: 'accepted'; id: string; duplicate: boolean }
  | { status: 'closed' | 'conflict' };
export interface IngressLease {
  id: string; owner: string; revision: number; expiresAt: number;
  phase: 'prepare' | 'handoff';
}
export type IngressMode = 'quiet' | 'engaged' | 'overhear';
export interface FrozenIngressRoute {
  mode: IngressMode; deliveryEventId: string; epoch: number;
  instanceId: string | null; target: ConversationTarget | null;
  binding: Binding | null; persona: Persona | null;
  skipAck: boolean; overhearNow?: string;
}
export interface IngressRow {
  id: string; team_id: string; event_id: string; digest: string; event_json: string;
  state: IngressState; revision: number; lease_owner: string | null;
  lease_expires_at: number | null; target_json: string | null;
  manifest_id: string | null; receipt_json: string | null;
  mode: IngressMode | null; instance_id: string | null; tracker_event_id: string | null;
  effects_complete: 0 | 1; next_attempt_at: number;
  prepare_attempts: number; handoff_attempts: number; failure_category: string | null;
  content_retention: 'retained' | 'tombstoned';
  ack_state: 'none' | 'intent' | 'sending' | 'posted' | 'skipped' | 'rejected' | 'uncertain';
  ack_json: string | null; ack_message_ts: string | null;
}
export function acceptSlackIngress(db: IngressDb, event: VerifiedIngressEvent,
  options?: { now?: number; id?: string }): Promise<IngressAcceptance>;
export function claimSlackIngress(db: IngressDb, id: string,
  options: { now: number; owner: string; leaseMs: number; phase: IngressLease['phase'] }): Promise<IngressLease | null>;
export function renewSlackIngressLease(db: IngressDb, lease: IngressLease,
  now: number, leaseMs: number): Promise<IngressLease | null>;
export function deferSlackIngress(db: IngressDb, lease: IngressLease,
  category: string, now: number, nextAttemptAt: number): Promise<boolean>;
export function readSlackIngress(db: IngressDb, id: string): Promise<IngressRow | null>;
export function listRecoverableSlackIngress(db: IngressDb, now: number, limit: number): Promise<string[]>;
export function failSlackIngress(db: IngressDb, lease: IngressLease,
  category: string, now: number): Promise<boolean>;
export function completeSlackIngress(db: IngressDb, lease: IngressLease,
  receipt: DispatchReceipt | null, now: number): Promise<boolean>;
export function requireIngressDb(value: unknown): IngressDb;
// events.ts; raw is the bounded, strictly decoded, signature-verified original body.
export function verifiedIngressEvent(raw: string, body: SlackEventEnvelope,
  event: SlackUserMessageEvent): Promise<VerifiedIngressEvent>;
// frozen-request.ts
export function storeFrozenRequest(db: IngressDb, lease: IngressLease,
  request: AgentDispatchRequest, now: number): Promise<boolean>;
export function loadFrozenRequest(db: IngressDb, ingressId: string): Promise<AgentDispatchRequest>;
// ingress-cleanup.ts; first rollout exposes this only to local tests and a separately authorized operation.
export function cleanupUnreferencedIngressAttempts(db: IngressDb,
  options: { now: number; limit: number }): Promise<{ deleted: number; retained: number }>;
// gateway/dispatch.ts
export function prepareProjectDispatch(env: Record<string, unknown>, request: ProjectDispatchRequest,
  options?: { expectedRoute: FrozenIngressRoute }):
  Promise<AgentDispatchRequest>;
export function dispatchPreparedProject(request: AgentDispatchRequest): Promise<DispatchReceipt>;
// ingress-ack.ts
export interface DurableAckInput {
  ingressId: string; token?: string; channel: string; threadTs?: string;
  oldestTs: string; text: string; persona: Persona | null;
}
export type DurableAckResult =
  | { status: 'posted'; ts: string }
  | { status: 'retryable-rejection'; retryAfterMs: number }
  | { status: 'skipped' | 'rejected' | 'uncertain' };
export function ensureIngressAck(db: IngressDb, lease: IngressLease,
  input: DurableAckInput, now: number): Promise<DurableAckResult>;
// gateway/slack-ingress.ts
export function recoverSlackIngress(env: Record<string, unknown>,
  options?: { limit?: number; now?: number; ingressId?: string }): Promise<{ processed: number; remaining: number }>;
```

The installed 2.2.2 public entry exports both `AgentDispatchRequest` and `DispatchReceipt`; use those exact types. `BoundD1Statement` deliberately describes the existing narrow product DB interface, rather than claiming a complete platform type. Require a real `batch` method at runtime. Use the ordinary `env.DB` binding for all ingress operations; without the Sessions API D1 executes queries on the primary. Do not wrap acceptance/readback in an unconstrained replica session. For narrow unit tests dependencies may inject top-level `dispatchPreparedProject`, but emitted native proof must exercise the actual function.

### Lease and transition contract

`revision` is the lease fencing token. Increment it on each successful claim, on deferral/failure, publication, and completion. Intermediate writes to route, acknowledgment, and checked product effects keep that token unchanged and are guarded by owner, revision, phase/state, and current expiry. Lease renewal returns the same revision with a new expiry, only while the old lease is live. Callers stop after any failed guard. Publication/completion invalidate the old handle; handoff always takes a new lease. Use a fresh clock reading immediately before each guarded operation, not the invocation's start time after awaited I/O. Test clocks may be injected through internal dependencies; the public recovery option `now` is a deterministic test override only.

| Operation | Required state | Result |
|---|---|---|
| Prepare claim | received, or preparing with no live lease; retry time reached | preparing, new owner/revision/expiry |
| Prepare defer | live prepare lease | preparing, lease cleared, next attempt set, revision advanced |
| Publish | live prepare lease, complete checked manifest and effects, final ack disposition | ready, lease cleared, revision advanced |
| Handoff claim | ready or uncertain with no live lease; retry time reached | same state, new owner/revision/expiry |
| Unknown dispatch | live handoff lease | uncertain, lease cleared, retry time set, revision advanced |
| Complete native handoff | live handoff lease and transaction guards satisfied | accepted, lease cleared, revision advanced, producer released |
| Complete quiet event | live prepare lease, quiet mode and checked effects | accepted without manifest/receipt, producer released |
| Definitive failure | live lease of either phase | failed, lease cleared, revision advanced, producer retained |

An expired `ready` handoff remains ready; an expired `uncertain` handoff remains uncertain. Neither can claim preparation or rebuild a request. A crash with `ack_state='sending'` becomes uncertainty on recovery, regardless of whether the network call started. Each successful claim increments its phase's durable attempt counter. Cap automatic claims at 8 per phase and use `min(120_000 * 2 ** (attempts - 1), 3_600_000)` milliseconds of backoff after a retryable/unknown attempt. At exhaustion retain state, producer and bytes, set safe retry-exhausted diagnostics, and exclude the record from automatic scans until explicit disposition. Never turn unknown native acceptance into a claimed rejection because a retry budget expired.

Scan at most 8 due records ordered by `next_attempt_at, created_at, id`, then process one ingress record. An optional internal `ingressId` hint prioritizes the just-accepted row but still honors lease, due-time and attempt limits; it cannot bypass backoff. A single record may progress from preparation/publication to a fresh handoff lease in the same invocation when its shared remaining budget permits. Otherwise ready state remains owned for cron. Budget exhaustion does not prove handoff failure. Persist safe failure categories; unavailable DB state is never a zero-obligation result.

### Payload retention and cleanup contract

The proposed first-rollout policy retains sanitized content for unfinished/native events, every published manifest, and every referenced request chunk. Failed events and producers remain until explicit disposition. After positive quiet completion with no native request/receipt and all required ambient effects checked, the same completion transaction replaces `event_json` with `{}` and sets `content_retention='tombstoned'`. This covers unbound/unknown-team/no-work events as well as completed ambient-only events, avoiding permanent extra webhook-text copies. Existing transcript/file authorization records are preserved. Identity, original digest, route disposition and safe audit fields remain so closed-fence duplicates never re-create work. This narrowed quiet-content policy is a proposal in the plan being presented for human review; it has not been executed. No age-based expiry or purge of referenced payloads is included.

Abandoned attempt cleanup may delete only an unreferenced manifest and its chunks after a 24-hour grace period, with its recorded preparation owner/revision no longer holding a live lease. Candidate selection alone does not authorize deletion. Recheck the ingress reference, attempt age, and lease in every DELETE statement inside one D1 batch; delete chunks first, then the manifest, and inspect both results. A publisher cannot publish an already-reclaimed attempt because publication checks completeness within SQL. Missing ingress, corrupt metadata, failed ingress, or an ownership/reference mismatch retains the attempt and raises a visible diagnostic. Process at most 8 candidates, within a separate budget; do not enable an automatic cleanup cron for this cutover.

Future removal of referenced bytes requires a separately reviewed privacy policy and positive native settlement plus completed product delivery/disposition. Receipt association alone is insufficient. It must retain audit identity/digest and mark payload removal explicitly; a purged payload cannot be reconstructed or dispatched. That future policy is outside this implementation. Capacity evidence must include retained-payload growth and remaining DB headroom before reopening. Tests cover the current conservative policy and abandoned attempt deletion; they must not imply future referenced cleanup is authorized.

### SQL completion guards

Task1's migration includes `BEFORE UPDATE OF state` and `AFTER UPDATE OF state` completion triggers. The BEFORE trigger aborts an attempted transition to accepted unless the exact `cutover_producers(id,source='slack',generation='g2',kind='intake')` row exists and checked product effects are complete. Quiet mode requires no manifest or native receipt. Native modes require a referenced manifest owned by this ingress and a validated receipt. Engaged mode additionally requires a matching reply tracker: frozen instance/event, target/persona/ack/publish, original submission ID, and compatible UID. Overhear mode has no engaged answer tracker; require its own native receipt and product effects, preserving existing quiet behavior.

Identity and original digest remain immutable. A separate `BEFORE UPDATE OF event_json,content_retention` guard permits content removal only in the same live-lease transition from preparing to accepted quiet mode, with checked effects, no manifest/receipt and `NEW.event_json='{}'`. It rejects tombstoning unfinished, native or failed events, and rejects any later content restoration. Quiet completion performs this update and producer release in the same batch; response loss reads the retained identity/digest and terminal disposition rather than preparing the empty JSON.

Use fixed-schema JSON with deterministic serialization for frozen comparison fields, validated before SQL. Validate JSON validity and required receipt strings in the trigger as well. Use null-safe `IS` comparisons for nullable persona/ack fields and reject null mode/identity; a SQL NULL predicate is not a passing guard. The AFTER trigger deletes exactly the matching producer. A missing/conflicting tracker or producer calls `RAISE(ABORT, 'ingress_completion_guard')`, rolling back all statements in the batch. Do not use `RAISE(IGNORE)`, `OR IGNORE`, or a JavaScript exception after a committed batch to claim rollback. Tracker updates in the batch also select through the same live lease and frozen identity. Stale lease no-ops therefore mutate neither tracker nor ingress and return false; they never release a producer. A lost commit response requires primary readback of accepted receipt/tracker/producer state before further dispatch.

The exact completion/publication triggers are implemented and proved against real migration SQL after execution approval. This review's in-memory acceptance-trigger and rollback checks are design evidence only; they do not certify those unimplemented guards. Accepted is a transport handoff state; native history and the existing outbox still prove execution and final delivery.

### Task 1: Atomic durable event acceptance and ownership

**Files:** Create `migrations/0033_slack_ingress.sql`, `src/slack/ingress-store.ts`, `src/slack/ingress-store.test.ts`, `src/slack/test-utils/ingress-db.ts`; modify `package.json` test script.

**Interfaces:** Produces `IngressDb`, event/state/lease types, `acceptSlackIngress`, `claimSlackIngress`, `listRecoverableSlackIngress`, `failSlackIngress`. Does not edit the Slack HTTP route yet.

- [ ] **Step 1: Write real-schema acceptance tests before implementation.** The production mutation that must fail them is separating ingress insertion from producer ownership or suppressing a matching retry.

```ts
test('durable acceptance: matching retry after closure retains one producer', async () => {
  const f = await ingressDbFixture('open'); // helper applies actual migrations through 0033
  const db = f.db;
  const event = await verifiedFixture({ eventId: 'E1', text: 'read this' });
  const first = await acceptSlackIngress(db, event, { id: 'I1', now: 100 });
  assert.deepEqual(first, { status: 'accepted', id: 'I1', duplicate: false });
  await f.closeIntake();
  assert.deepEqual(await acceptSlackIngress(db, event, { id: 'I2', now: 101 }),
    { status: 'accepted', id: 'I1', duplicate: true });
  assert.equal(f.count('slack_ingress'), 1);
  assert.equal(f.count('cutover_producers'), 1);
  assert.equal((await acceptSlackIngress(db, await verifiedFixture({ eventId: 'E2' }))).status, 'closed');
  const differentDigest = event.digest === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
  assert.equal((await acceptSlackIngress(db, { ...event, digest: differentDigest })).status, 'conflict');
});
```

Create the test helper from `src/cutover/test-fixtures.ts`, not by importing the existing signed-route `ingressFixture` under a second meaning. It binds `Uint8Array` unchanged, wraps `batch` in `BEGIN/COMMIT` with `ROLLBACK` on any statement error, and reports actual changes/results. `openIntake/closeIntake/count/dispose` exist only on the fixture. Dispose the in-memory DB in `finally` in every actual test, omitted in these short examples. `verifiedFixture` hashes deterministic original verified fixture bytes and separately selects sanitized fields; its digest is not a hash of the sanitized JSON.

Add tests for statement error rollback, trigger failure, new-event/fence-close race ordering, duplicate simultaneous IDs, conflict under open/closed, missing control/table and ambiguous insert response followed by recovery. Inject response loss after actual SQL commit, not before it.

- [ ] **Step 2: Run `npx tsx src/slack/ingress-store.test.ts`.** Expected RED: exports/schema absent; after adding schema fixture but before behavior, assertions fail on missing durable acceptance. Do not accept a syntax/import error as final RED evidence.

- [x] **Step 3: Add the reviewed additive schema.** Core constraints:

```sql
CREATE TABLE slack_ingress (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL, event_id TEXT NOT NULL, digest TEXT NOT NULL,
  event_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'received'
    CHECK(state IN ('received','preparing','ready','uncertain','accepted','failed')),
  revision INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT, lease_expires_at INTEGER,
  target_json TEXT, manifest_id TEXT, receipt_json TEXT,
  mode TEXT CHECK(mode IN ('quiet','engaged','overhear')),
  instance_id TEXT, tracker_event_id TEXT,
  effects_complete INTEGER NOT NULL DEFAULT 0 CHECK(effects_complete IN (0,1)),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  prepare_attempts INTEGER NOT NULL DEFAULT 0 CHECK(prepare_attempts>=0),
  handoff_attempts INTEGER NOT NULL DEFAULT 0 CHECK(handoff_attempts>=0),
  content_retention TEXT NOT NULL DEFAULT 'retained'
    CHECK(content_retention IN ('retained','tombstoned')),
  failure_category TEXT,
  ack_state TEXT NOT NULL DEFAULT 'none'
    CHECK(ack_state IN ('none','intent','sending','posted','skipped','rejected','uncertain')),
  ack_json TEXT, ack_message_ts TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(team_id,event_id)
);
CREATE INDEX slack_ingress_recovery ON slack_ingress(state,next_attempt_at,created_at,id);
CREATE TRIGGER slack_ingress_owns_producer AFTER INSERT ON slack_ingress
BEGIN
  INSERT INTO cutover_producers(id,source,generation,kind,admitted_at)
  VALUES(NEW.id,'slack','g2','intake',NEW.created_at);
END;
CREATE TABLE slack_ingress_manifests (
  id TEXT PRIMARY KEY, ingress_id TEXT NOT NULL REFERENCES slack_ingress(id),
  encoding_version INTEGER NOT NULL CHECK(encoding_version=1),
  total_bytes INTEGER NOT NULL CHECK(total_bytes>0 AND total_bytes<=11495904),
  chunk_count INTEGER NOT NULL CHECK(chunk_count>0 AND chunk_count<=12),
  digest TEXT NOT NULL, created_at INTEGER NOT NULL,
  preparation_owner TEXT NOT NULL, preparation_revision INTEGER NOT NULL
);
CREATE TABLE slack_ingress_chunks (
  manifest_id TEXT NOT NULL REFERENCES slack_ingress_manifests(id),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<12),
  bytes BLOB NOT NULL CHECK(length(bytes)>0 AND length(bytes)<=1000000),
  digest TEXT NOT NULL,
  PRIMARY KEY(manifest_id,ordinal)
);
```

Add the completion/content guards described above to this migration, with real-schema rollback tests. Also add a publication guard that checks manifest ingress ownership, preparation owner/revision, exact chunk count, contiguous ordinals and total BLOB length before ready. An immutable manifest/chunk set cannot be updated after insertion; deletion is limited to the cleanup contract. Compute hashes from original bytes before writes; validate stored bytes by full readback before first dispatch and every replay. These checks ensure cleanup cannot remove a candidate between JavaScript validation and SQL publication. No native tables or earlier migration are edited. A duplicate `DO NOTHING` must not fire the ownership trigger. Use actual migration application/order tests to ensure foreign keys and triggers work with the existing database, including the local Wrangler migration command against a fresh fixture-only persistence directory. Never substitute a remote migration for that local tooling check.

Acceptance insert uses the primary control row and no read/insert gap:

```sql
INSERT INTO slack_ingress(id,team_id,event_id,digest,event_json,created_at,updated_at)
SELECT ?,?,?,?,?,?,? FROM cutover_control WHERE id=1 AND state='open'
ON CONFLICT(team_id,event_id) DO NOTHING;
```

Perform insert plus canonical ingress/control/producer readback in one primary-bound batch. Read the canonical row by team/event; digest match means accepted duplicate regardless of fence, different digest means conflict, no row under valid closed control means closed. No canonical row under open control is unavailable, never guessed accepted. Missing/invalid control or DB errors are unavailable. Check the producer for nonterminal ingress; accepted duplicates must verify recorded completion rather than recreate released ownership. IDs use a fresh UUID only for the proposed first insert; a retry recovers the original id. Do not use a producer-trigger-inflated `meta.changes` value alone to determine `duplicate`; canonical id plus readback decides it.

Validate team/event identities, SHA-256 hex, byte-size bound, and `key === teamId + ':' + eventId` before SQL. The native key `slack:${key}` must fit the pinned 256-character limit. Use the scoped key consistently for native event correlation, tracker event_id and overhear key; retain the original Slack event_id separately. Test original user-text strings are retained exactly in the sanitized event. Original raw bytes are hashed, not persisted.

Implement both lease phases from the transition table. Prepare claim uses `UPDATE ... WHERE revision=? AND prepare_attempts<8 AND next_attempt_at<=? AND (state='received' OR (state='preparing' AND (lease_owner IS NULL OR lease_expires_at<=?)))`, increments revision and prepare_attempts, and writes owner/expiry. Handoff claim restricts state to ready/uncertain, handoff_attempts<8 and absent/expired lease, incrementing handoff_attempts without changing state or manifest. Use guarded UPDATE RETURNING or a transactional write/readback batch to return the acquired token. Renew, defer, and fail require the current phase/state, owner/revision and unexpired lease; a terminal transition clears the lease. No ready/uncertain row can claim preparation. Test null leases, every transition, expiry equality, stale renewals, exponential backoff/cap, exhausted uncertainty retention, due-time ordering and hint behavior. Initial lease length is 60 seconds, renewed before long bounded operations; its expiry is a correctness check, not permission to retry an ambiguous post.

- [x] **Step 4: Run targeted tests, `npm run typecheck && npm test`.** Expected GREEN: one event/producer and correct lease/rollback behavior; all existing tests stay green. Add new test files to test script before whole suite.
- [x] **Step 5: Ledger schema/ownership evidence, no automatic commit.** No remote migration is applied.

### Task 2: Immutable bounded request storage and gateway preparation split

**Files:** Create `src/slack/frozen-request.ts`, `src/slack/frozen-request.test.ts`, `src/slack/ingress-cleanup.ts`, `src/slack/ingress-cleanup.test.ts`; modify `src/gateway/dispatch.ts`, `src/gateway/dispatch.test.ts`, `package.json`.

**Interfaces:** Consumes Task1 DB/lease and existing `ProjectDispatchRequest`; produces `prepareProjectDispatch`, `dispatchPreparedProject`, `storeFrozenRequest`, `loadFrozenRequest`.

- [ ] **Step 1: Write storage/preparation RED tests.** A changed attachment/order or stale publisher must fail them.

```ts
test('frozen request: Unicode and two large attachments reconstruct identically', async () => {
  const f = await preparingIngressFixture();
  const db = f.db;
  const request = largeImageRequest({ context: '世界🙂', imageBytes: 4_000_000, imageCount: 2 });
  assert.equal(await storeFrozenRequest(db, f.lease, request, 200), true);
  const restored = await loadFrozenRequest(db, f.lease.id);
  assert.deepEqual(restored, request);
  assert.equal(new TextEncoder().encode(JSON.stringify(restored)).length,
    new TextEncoder().encode(JSON.stringify(request)).length);
  assert.ok(f.maxBlobBytes() <= 1_000_000);
  assert.ok(f.chunkCount() <= 12);
});
test('expired preparer cannot publish or dispatch its candidate', async () => {
  const f = await preparingIngressFixture();
  const old = f.lease;
  await f.expireAndReclaim();
  assert.equal(await storeFrozenRequest(f.db, old, textRequest(), f.now), false);
  await assert.rejects(() => loadFrozenRequest(f.db, old.id));
});
```

`largeImageRequest`, `textRequest` and fixture lease controls live in test utilities and use real prepared type/envelope shapes. The preparing fixture commits route/effect/ack prerequisites before storage tests. Add malformed JSON, over bound, missing/changed/invalid-ordinal chunks, mismatched count/length/digest, crash after chunk write and before publication, competing publishers, lease expiry and exact initialData/envelope-string preservation cases. Physical row insertion order is irrelevant; reading must order by ordinal. A changed ordinal-to-bytes association fails digest checks.

Write cleanup tests for referenced received/preparing/ready/uncertain/accepted/failed payload retention, live and just-expired leases, grace boundary, abandoned attempt deletion, publication/cleanup race in both orderings, crash after deleting chunks, corrupt/missing metadata, response loss after cleanup commit, and bounded scans. Repeated cleanup must leave referenced bytes and tombstones intact. A candidate published before cleanup is retained; cleanup committed first prevents that attempt from becoming ready.

Add gateway assertion that `prepareProjectDispatch` produces the same prepared request as prior dispatch without invoking native; `dispatchProject` still invokes native exactly once for existing callers. Existing capability/media/drop/context tests remain unchanged in intent.

- [ ] **Step 2: Run `npx tsx src/slack/frozen-request.test.ts && npx tsx src/gateway/dispatch.test.ts`.** Expected RED: absent storage/preparation functions or stale publisher incorrectly accepted, followed by behavior RED after compiling scaffold.

- [x] **Step 3: Split preparation without changing behavior.** Move the existing body up to native call into `prepareProjectDispatch`; wrap unchanged error classification. Add:

```ts
export async function dispatchPreparedProject(request: AgentDispatchRequest): Promise<DispatchReceipt> {
  return dispatch(Project, request);
}
export async function dispatchProject(env: Record<string, unknown>, request: ProjectDispatchRequest): Promise<DispatchReceipt> {
  return dispatchPreparedProject(await prepareProjectDispatch(env, request));
}
```

Serialize the product-produced JSON-safe request once as UTF-8 bytes with encoding version 1. Reject unsupported non-JSON values instead of silently changing attachment/initialData representation. SHA-256 uses Worker-compatible Web Crypto. Recheck `UTF8(JSON.stringify({agent:'project', ...request})).length + 4096 <= 11_500_000`; a request satisfying a larger storage-only bound cannot bypass the existing native application bound. Verify secret exclusion from approved request fields without logging forbidden values; do not attempt a heuristic that destroys user text matching a token-like string.

Store an unpublished attempt manifest through the live prepare lease, recording owner/revision, then write one bound BLOB chunk at a time through that same lease. Small batches are allowed only after measured memory evidence; do not require one large 12-chunk batch. A crash can leave a partial attempt, which remains invisible and follows abandoned-attempt cleanup rules. Use at most 12 chunks plus one manifest. Compute chunk and whole-request SHA-256 from the original serialized bytes before writes. Publication's SQL count/ordinal/length checks establish completeness; the mandatory full readback/hash check occurs before first dispatch and every replay. If any additional full readback before publication is chosen, count its queries/memory explicitly. Bind BLOBs, never interpolate bytes. Normalize D1 BLOB reads from their documented array representation to `Uint8Array`, checking every byte; tests must cover platform arrays and SQLite typed arrays.

Publication is a separate guarded `UPDATE slack_ingress SET manifest_id=?,state='ready',revision=revision+1,lease_owner=NULL,lease_expires_at=NULL,... WHERE id=? AND state='preparing' AND lease_owner=? AND revision=? AND lease_expires_at>?`. The publication trigger checks the complete candidate inside SQL, including mode/effects and final ack state. An ambiguous publication response requires primary readback: use the already-published manifest if present, never replace it. A different winning manifest invalidates this candidate. Return false on stale no-op, do not dispatch. Failure after chunk write leaves an abandoned attempt under the retention rules. No INSERT/UPDATE may mutate a published manifest or its chunks.

Read the published manifest, allocate one bounded reconstruction buffer, then read one chunk at a time in ordinal order. Verify each byte-array/digest/length and copy it into the buffer, releasing the platform array before loading the next chunk. Holding all D1 number arrays at once can exhaust Worker memory despite legal row sizes. Verify contiguous count and whole digest, then decode once with fatal UTF-8 decoding. Enforce the application bound again. Return the exact parsed request, not a rebuilt `ProjectDispatchRequest`. Count the additional per-chunk queries in the handoff budget and measure peak memory in actual binding proof.

- [x] **Step 4: Run both targeted files and full typecheck/suite.** Expected GREEN, no gateway behavior drift. Record local SQLite BLOB proof separately from remote D1 capacity.
- [x] **Step 5: Ledger immutable publication, payload retention and abandoned-attempt cleanup proof; no automatic commit/deploy.** Do not implement cleanup of referenced payloads or enable automatic deletion.

### Task 3: Recoverable event preparation and uncertainty-aware working acknowledgement

**Files:** Create `src/slack/accepted-event.ts`, `src/slack/accepted-event.test.ts`, `src/slack/ingress-ack.ts`, `src/slack/ingress-ack.test.ts`; modify `src/slack/ack.ts` only as needed for reuse, `src/slack/post.ts` and `post.test.ts` only for safe rate-limit response metadata, `src/slack/reconcile-post.ts` and its tests for bounded lookup, `src/knowledge/reflection.ts` and its tests only for transcript idempotency, existing Slack route tests, `package.json`. The separate missing-table reflection query remains unchanged in this task.

**Interfaces:** Consumes Task1 lease/record and Task2 preparation; produces:

```ts
export type AcceptedEventPreparation =
  | { kind: 'quiet' }
  | { kind: 'pending-ack'; retryAfterMs?: number }
  | { kind: 'native'; request: ProjectDispatchRequest; route: FrozenIngressRoute;
      ackMessageTs?: string };
export function prepareAcceptedSlackEvent(env: Record<string, unknown>, row: IngressRow,
  lease: IngressLease): Promise<AcceptedEventPreparation>;
```

`target_json` contains `FrozenIngressRoute`, selected once and persisted by lease CAS before Slack effects. It freezes mode, trusted target, epoch, instance, scoped event/key, binding identity, acknowledgment persona/skip decision, and overhear timestamp. On retry read it rather than recalculating engagement, active-turn status, persona or epoch. A quiet unbound event has null binding/target/instance and must complete explicitly; do not silently lose its producer.

Select the binding/epoch on primary reads, ensure the conversation target exists, then commit the route with predicates checking the same active binding fields and current target epoch. When a seeded binding takes precedence, compare it to the immutable code-selected seed and guard the D1 target epoch; record which binding source was used in the route JSON. A binding/reset winning before route commit makes the CAS fail and preparation retry selection; after route commit the route remains immutable. No external effect occurs before that commit. Test both race orderings with actual SQL, including a seeded route, disabled binding, and no-target first event.

`prepareProjectDispatch` takes the optional `expectedRoute` only from this trusted internal path. Check the loaded snapshot's project/slug/provider/account/space/bot/token-reference identity against it before media or native work. Reuse the frozen persona in the resulting snapshot/tracker. A destination mismatch becomes a retained route conflict; do not redirect the event or reset its epoch. Other context may refresh only during unpublished preparation. Existing callers without `expectedRoute` retain their behavior. Once ready, use only stored request bytes. Never expose this option on a public route.

- [ ] **Step 1: Write RED ack-loss and preparation tests.** Production counterexample: retry calls `chat.postMessage` twice or replaces target after epoch changes.

```ts
test('lost ack response repairs from metadata without repost', async () => {
  const fixture = await durableAckFixture();
  fixture.slack.acceptPostThenLoseResponse();
  const first = await ensureIngressAck(fixture.db, fixture.lease, fixture.input, 100);
  assert.equal(first.status, 'uncertain');
  fixture.slack.exposePositiveMetadataMatch('22.0');
  const recovered = await ensureIngressAck(fixture.db, fixture.lease, fixture.input, 101);
  assert.deepEqual(recovered, { status: 'posted', ts: '22.0' });
  assert.equal(fixture.slack.postCount, 1);
});
```

Also test missing metadata stays uncertain/no second post; crash after marking sending before network conservatively uncertain; permanent Slack rejection visible; unknown/missing timestamp uncertain; late success after timed wait repairs exactly once; missing token skipped only where original behavior allowed; joined turn deliberately has no borrowed ack. Test competing lease holders, a stale late success, scope/time/author/metadata mismatches, duplicate metadata matches, two-page exhaustion and malformed lookup response. A fixture with more than 200 historical replies before the triggering event must still find its later ack using the time lower bound. Test 429/Retry-After and documented rate-limited rejection followed by one successful post, plus a lost 429 response that remains uncertain and never reposts. Test extraction preserves ambient file authorization/logging, DM/bare mention images, bounded history, persona, active-turn joins, and overhear policy.

- [ ] **Step 2: Run new ack/preparation tests.** Expected behavior RED after compilable scaffold; no assertions merely on a mock's internal decision.

- [x] **Step 3: Add durable ack intent.** Choose and persist text/persona/destination plus deterministic delivery ID `ingress-ack:<ingressId>` before first post. `ensureIngressAck` requires its ingressId to equal the lease id. Choose text once with the existing picker, not again on retry. Persist the token-reference name through the trusted route; resolve the token only in memory on each attempt. Use existing `postMessage` `deliveryId` metadata and `findPostedReply` positive matching. Add optional lookup options with maxPages=2, page size=100, and `oldestTs` from the immutable triggering event timestamp. Pass `oldest` and `inclusive=true` to replies/history while preserving the parent `ts` for replies. This avoids scanning a long thread from its beginning. Preserve existing callers and return type; actual Slack pages may be smaller than requested. Exhaustion/no match returns no repair, never repost permission. Confirm frozen channel/thread and bot/app identity before adopting a timestamp. Multiple or mismatched matches stay uncertain.

Claim `intent→sending` by owner/revision/current-expiry CAS before network. Already sending/uncertain may perform history lookup but never call post again. Keep the claim revision unchanged for intermediate ack writes under the shared lease contract. Post success writes posted/ts only through a live lease; a stale successful response cannot mutate the new owner's record, and its timestamp must be recovered through positive metadata later.

Classify explicit not-posted transient rejection separately. Extend `SlackApiError` with optional safe HTTP status and Retry-After seconds while preserving its existing code/constructor callers. Recognize an observed HTTP 429 before JSON parsing, or documented `ratelimited`/`rate_limited` rejection, as retryable-rejection. Under a live lease return ack to intent, keeping the same text/persona/metadata identity. Return the safe retry delay through `AcceptedEventPreparation` to recovery, which alone defers the lease for at least Retry-After and the phase backoff. `ensureIngressAck` does not release or defer the lease itself. This is permitted only after positive rejection evidence; losing that response remains sending/uncertain and prohibits repost. A known permanent rejection remains rejected; unrecognized error, timeout, HTTP 5xx, malformed response or missing success timestamp stays uncertain. Do not retry arbitrary transient-looking exception text. The customize-scope fallback remains allowed only after positive rejection, using the same delivery metadata. Log safe categories only.

Working ack is chrome, not a native input acceptance owner. Freeze its known timestamp or explicit skipped disposition into the request once. Joined turns and allowed missing-token cases persist a skipped reason. Permanent Slack rejection is retained as failed preparation and a cutover blocker. Retryable positive rejection only returns the same intent to its delayed retry; it is not dispatch permission. Keep uncertain ack visibly pending, without a fabricated or borrowed timestamp. Publication accepts posted/skipped for engaged work and skipped for quiet/overhear. Live metadata retention remains a separate rollout gate.

Extract current `/slack/events` business block into `prepareAcceptedSlackEvent`, leaving HTTP integration for Task4. Preserve `autoCreateBinding` trusted-team rules and existing `normalizeSlackMessage`, `slackMediaContext`, file authorization, tracker target semantics and personality. Replace KV decision sites with inbox idempotent state, not a new KV claim.

Ambient and engaged transcript writes must not duplicate on preparation retry. Migration `0031_messages_delivery_id.sql` already provides nullable `messages.delivery_id` with a unique index. Add optional `deliveryId` to `LogMessageInput` and use `ON CONFLICT(delivery_id) DO NOTHING` for durable ingress logging with `ingress-transcript:<ingressId>`; existing callers without a delivery ID preserve their append behavior. Do not add an effect-marker table or change migration 0031. Read back a conflicting delivery ID and verify project/conversation/sender/role/text/ambient identity rather than treating any collision as completion. If normalized text is empty, persist an explicit skipped transcript effect. Retain the existing ambient attachment-only fallback text. Preserve the first transcript timestamp on retry.

File authorization upserts are repeatable, but their completion and the transcript check must succeed before lease-guarded `effects_complete=1`. Do not swallow errors as completed effects. Check the current lease before every product write and guard ownership-dependent statements within SQL. Chunk large file lists into bounded batches of at most 10 upserts; budget exhaustion yields retained preparation, and the next attempt repeats idempotent upserts. Freeze overhear timestamp/instructions/key before native handoff; its route mode distinguishes native acceptance with no engaged tracker. A pure ambient event completes only after its checked effects succeed. Add actual-SQL retry tests for both engaged and ambient transcripts, conflicting delivery identity, multiple files, empty text and completion-write response loss. Add quiet-content tests: unbound/unknown-team/no-work and completed ambient-only events atomically tombstone only their extra event copy; transcript/file records and identity/digest survive; unfinished/native/failed content cannot be removed; lost completion response and closed-fence duplicate never re-create work or parse a tombstone as a new event.

For engaged events seed trusted tracker before native handoff; verify its frozen target/persona/ack/publish identity through primary readback. Existing `seedReplyTracker` uses DO NOTHING; use a narrow checked path or guarded caller SQL with real-schema mismatch tests. `createSlackTurnActivity` currently upserts and can reset an existing receipt: do not call it again unconditionally on preparation retry. Read the current activity, reuse only a matching own ack and target, and conditionally create the initial row without overwriting another turn's activity. Joined events remain skipped. Missing/failed required receipt persistence stays visible; optional eyes reactions retain existing idempotent best-effort behavior. Test a retry after activity completion and two events sharing one conversation.

- [x] **Step 4: Run focused new tests, existing ack/threads/delivery/gateway tests, typecheck and full suite.** Expected GREEN; no new public agent transport.
- [x] **Step 5: Ledger acknowledgment liveness tradeoff.** Missing positive evidence can hold preparation; explicit operational disposition, not blind retry, is the escape. No automatic commit.

### Task 4: Switch signed HTTP ingress to durable fast acceptance

**Files:** Modify `src/app.ts`, `src/cutover/ingress.test.ts`, `src/slack/events.ts` and tests; add `src/slack/ingress-http.test.ts`; modify `package.json`.

**Interfaces:** Consumes `acceptSlackIngress`; schedules recovery opportunistically but owns no durable work in execution context. No production route provides arbitrary native request input.

- [ ] **Step 1: Write signed route tests before changing route.** Construct real Slack HMAC fixtures with actual app import as existing cutover ingress tests do.

```ts
test('HTTP200 waits for inbox commit, not preparation', async () => {
  const f = await signedIngressFixture();
  f.db.holdAcceptanceCommit();
  const response = f.postEvent({ eventId: 'E1', text: '<@BOT> inspect this' });
  await f.db.acceptanceEntered;
  assert.equal(f.responseResolved, false);
  assert.equal(f.slackHistoryCalls, 0);
  assert.equal(f.slackPostCalls, 0);
  assert.equal(f.nativeAdmissions, 0);
  f.db.releaseAcceptanceCommit();
  assert.equal((await response).status, 200);
  assert.equal(f.db.ingressCount(), 1);
  assert.equal(f.db.producerCount(), 1);
});
```

A test-only held promise models the actual insert execution boundary, not a sleep-based timing guess. Add valid signature/unknown signature, challenge, non-user event, closed new503, closed duplicate200, conflict409, unavailable503, unknown commit retry, team validation and input bounds. Verify redelivery stable key requires nonempty provider event_id; missing provider identity rejects visibly rather than inventing a new key. If historical fallback event IDs must be preserved for local synthetic fixtures, update fixtures to real provider IDs; do not weaken production identity.

Measure serialized valid event fixtures with file attachments, DM, mention and ambient events, and set explicit maximum raw/sanitized sizes no greater than 1,000,000 bytes. Add exact-bound/over-bound tests; record selected bound and 413 rejection before acceptance. Read raw body with a bounded reader before HMAC so chunked over-limit bodies cannot allocate unbounded input. Reject invalid UTF-8 rather than hashing a replacement-decoded string. Digest original verified bytes; store only selected safe event fields, including metadata-only files id/name/mimetype/size, original team/event identity and the verified app identity needed for metadata repair. Malformed supported work returns a safe 400; unverified work returns 401. A user-editable nested value cannot replace the provider event/team identity. Do not persist raw bytes or change user text while stripping private metadata fields.

- [ ] **Step 2: Run new HTTP and existing ingress tests.** Expected RED: existing route starts history/ack/native before durable commit or rejects matching closed duplicate.

- [x] **Step 3: Replace only the verified user-event branch.** Keep current signature/challenge/non-user policy. Minimal route shape:

```ts
const event = await verifiedIngressEvent(raw, body, ev); // original digest, safe fields, trusted team/id
const db = requireIngressDb(c.env.DB); // missing batch/DB -> explicit503, not KV fallback
const accepted = await acceptSlackIngress(db, event);
if (accepted.status === 'closed') return c.json({ error: 'admissions unavailable' }, 503);
if (accepted.status === 'conflict') return c.json({ error: 'event identity conflict' }, 409);
try {
  c.executionCtx.waitUntil(recoverSlackIngress(c.env, { limit: 1, ingressId: accepted.id }).catch(() => {
    console.log('[slack-ingress] recovery deferred');
  }));
} catch {
  console.log('[slack-ingress] recovery deferred');
}
return c.body(null, 200);
```

Define `verifiedIngressEvent` and `requireIngressDb` in the indicated event/store modules and test their real exports; they are not assumed helpers. `verifiedIngressEvent` computes the original-byte digest asynchronously with Web Crypto. `requireIngressDb` checks prepare/batch structurally and returns the primary binding. Handle failed/unknown SQL acceptance as safe 503. A rejected or unavailable opportunistic `waitUntil` registration after commit still returns 200 because the inbox already owns the work; add a synchronous throw test. Never roll back acceptance or recreate a producer to compensate for a scheduling failure.

No new `beginIntake` for the same event: Task1 trigger owns it. Remove orphan imports/helpers created by extraction only. Leave non-Slack KV use and unrelated routes unchanged. Preserve current unknown-team/unbound behavior in durable preparation and release the accepted quiet event explicitly. Track acceptance failures safely without original payload/exception text.

- [x] **Step 4: Run signed route tests, existing Slack/cutover tests, typecheck and full suite.** Expected GREEN; before-commit unavailable path never returns200. Record actual local latency observations without a universal SLA claim.
- [x] **Step 5: Ledger route migration and no-production state.** No commit/deployment yet.

### Task 5: Durable backstop, exact native handoff and cutover counters

**Files:** Create `src/gateway/slack-ingress.ts`, `src/gateway/slack-ingress.test.ts`; modify `src/app.ts` internal route, `src/cloudflare.ts`, `src/cutover/cron.test.ts`, `src/cutover/diagnostics.ts`, `diagnostics.test.ts`, `evidence.ts`, `evidence.test.ts`, `report-cli.test.ts`, `src/slack/ingress-store.ts`, `package.json`.

**Interfaces:** Consumes preparation/store and existing receipt/tracker functions. Produces bounded `recoverSlackIngress`. Accepted original producer remains owned across a closed fence; no fresh intake/drain registration is fabricated.

`recoverSlackIngress` clamps `limit` to one ingress record for this rollout; its optional public `now` never freezes production time across awaited calls. `processed` counts claimed records, including retained/deferred failure; `remaining` counts due or retained nonterminal work, not a success certificate. Preparation uses `prepareAcceptedSlackEvent`, then `prepareProjectDispatch` with the persisted route, then `storeFrozenRequest`. Quiet preparation uses `completeSlackIngress` directly. Pending ack uses `deferSlackIngress` once with `max(phaseBackoff, retryAfterMs ?? 0)`; budget deferral also clears the live lease once. Handoff always takes a fresh phase lease, validates frozen storage, verifies the live lease immediately before native contact, and then completes or records uncertainty.

After publishing one record, the same invocation may continue its handoff if at least 20 statement slots remain in the shared budget, including reconstruction, lease check, tracker completion and deferral reserve. Measure the actual maximum handoff path and raise the reservation if necessary. Otherwise stop with ready state and let cron claim it; do not fabricate a fresh budget by registering another waitUntil. Tests must prove prompt same-invocation handoff on the ordinary path and retained ready recovery on exhausted budget. Expiry during a native call cannot prevent an in-flight send; exact replay convergence, not the lease alone, establishes safety.

- [ ] **Step 1: Write unknown-native and ownership RED tests.** Mutations that must fail: preparing again under same key, early release after a lost receipt, or accepted work rejected on closed intake.

```ts
test('receipt loss replays stored request without refreshing preparation', async () => {
  const f = await ingressRecoveryFixture();
  f.native.acceptThenLoseReceipt();
  await recoverSlackIngress(f.env, { limit: 1, now: 100 });
  assert.equal(f.state(), 'uncertain');
  assert.equal(f.producerCount(), 1);
  f.closeFence();
  f.changePersonalityAndEpoch();
  await recoverSlackIngress(f.env, { limit: 1, now: 120_100 }); // first 120-second backoff elapsed
  assert.deepEqual(f.native.requests[1], f.native.requests[0]);
  assert.equal(f.preparationCount, 1);
  assert.equal(f.native.uniqueAdmissions, 1);
  assert.equal(f.state(), 'accepted');
  assert.equal(f.producerCount(), 0);
  assert.equal(f.trackerSubmissionId(), f.native.originalSubmissionId);
});
```

This focused native double asserts transport control; Task6 proves actual pinned native convergence. Add crash before/after tracker association and producer release, duplicate recovery, conflicting receipt, missing/corrupt request, lease contention, pending ack, ambient completion, preparation failure, native changed-payload conflict, definitive rejection, and bounded scan/query budget cases. No test treats swallowed error as completed effect.

- [ ] **Step 2: Run recovery/cron/diagnostic tests.** Expected RED: absent consumer/counters; compile scaffolds before recording behavior RED.

- [x] **Step 3: Implement recovery with state-based dispatch.** One invocation processes at most one ingress record, potentially including both preparation and handoff within its shared budget; scan limit 8. Received/expired-preparing uses preparation CAS. Ready/uncertain claims handoff without changing immutable manifest. Load/verify request, call `dispatchPreparedProject`, retain unknown outcome, and persist receipt with exact target identity. Native conflict/failure is visible, never a new key. Add fairness/hint, immediate handoff, shared-budget exhaustion and capped uncertainty tests.

Use a narrow native error allowlist. Public `SubmissionConflictError` is a retained conflict; pre-dispatch `ProjectAdmissionError` is a proven preparation rejection. Pinned native `FlueError.type==='invalid_request'` denotes validated admission rejection; `InvalidRequestError` itself is not a public root export, so do not import it from that entry. Only match these trusted typed errors at their documented boundary. All other failures after native contact are uncertain unless pinned source plus a regression proves rejection before admission. Preserve any prior unknown attempt even when later evidence is inconclusive. Retry cap retains unknown state/producer/bytes and blocks cutover; it never creates a replacement key or claims the model failed.

Association completion uses one D1 batch for guarded tracker association and the transition to accepted. Implement `completeSlackIngress(db, lease, receipt: DispatchReceipt | null, now): Promise<boolean>` in ingress-store. Validate the receipt's nonempty submissionId/uid/acceptedAt and identity against the frozen request; ignore the advisory deduplicated flag for receipt equality. The completion triggers enforce the SQL guard protocol above. Existing `attachReplySubmission` silently permits no-op and COALESCE UID behavior, so this new path must validate target/persona/ack/publish and reject a different existing UID as well as submission. Do not broadly change unrelated delivery callers.

Add real-SQL tests: missing tracker, conflicting target/persona/ack/publish/submission/UID, missing/wrong producer, stale lease after tracker write, and injected final statement failure all leave producer and pretransaction association intact. Crash after committed completion and lost response recovers accepted state without replay or second release. A crash after native acceptance but before that commit retries only the stored exact request. If native-history recovery attached the same submission earlier, completion accepts the exact association idempotently and preserves advanced tracker status; it never resets delivered/staged to pending. `accepted` is not proof final answer delivered; existing tracker/outbox counters own that obligation. Quiet mode accepts with no receipt only after checked effects; overhear mode requires its native receipt with no engaged tracker.

Add guarded `POST /__internal/slack-ingress/reconcile`: existing heartbeat secret, bounded fixed request shape, no caller-provided native request/key/target. Recovery drains durable accepted work even while fence closed. Existing RECONCILE_CRON calls it; no SDK alarm override/new cron needed. `waitUntil` invokes the same recovery path promptly after HTTP acceptance.

Extend diagnostics with required g2 counters `slackIngressPending`, `slackIngressFailed`, `slackIngressAckUncertain`, and `slackIngressStorageInvalid`. Pending means received/preparing/ready/uncertain. Ack uncertainty counts sending/uncertain; failure counts failed or a retained rejected ack. Storage invalid counts missing manifest/chunks, wrong ownership, noncontiguous ordinals, or inconsistent SQL byte/count metadata for a published request. Hash corruption detected on load additionally persists a safe failure category. SQL counts alone cannot certify every BLOB hash: the final storage-integrity observation must validate every outstanding published request in bounded batches, with incomplete coverage reported as unknown. No unbounded attachment loading in the status route.

Missing ingress/manifest/chunk schema and incomplete integrity coverage are unknown, never zero. This native-only new schema must not require copying into the historical beta bridge; update generation-specific evidence required counters and fixtures. Ordinary terminal failed ingress remains blocking pending explicit disposition. The legacy seven-counter product observation is evidence about its recorded build only, not a schema-0033 clearance. Offline evaluator continues to derive blockers from counters and reject incomplete evidence.

Use one query-accounting scope per actual Worker invocation, including existing context/file authorization/tracker calls and every batch statement. The webhook's acceptance batch and waitUntil recovery share that scope. `src/cloudflare.ts:callInternal` calls `app.fetch` in-process, so all reconciliation routes and their background work share the scheduled invocation's scope too. Internal URLs do not grant fresh platform budgets. Pass the same counted DB adapter/context through these paths using invocation-local environment copies; never mutate the shared platform environment or use a process-global counter. Reserve enough operations for deferral before a costly stage, and start ingress only when the aggregate remaining budget permits. Observe existing routes without silently changing their behavior or limits.

Count emitted statements and actual platform usage separately; initially use a conservative 50-statement invocation budget. Verify the actual applicable Free/Paid limit in the isolated deployment proof instead of inferring it from Sandbox config. Test both signed HTTP acceptance-plus-recovery and the full scheduled handler with all existing routes using the same counter. If either aggregate cannot fit, stop for reviewed budget/phase changes; do not drop files, loop on an impossible stage, invent a fresh budget, or silently alter unrelated reconcilers. Timeouts leave retained state and no fresh native key.

- [x] **Step 4: Run focused recovery/cron/evidence/CLI tests, typecheck and full suite.** Expected GREEN, accepted work drains closed and new intake does not.
- [x] **Step 5: Ledger handoff ownership boundary and query budgets.** No automatic commit/deploy or marker deletion.

### Task 6: Emitted native crash/replay, storage-capacity gate and deployment handoff

**Files:** Create `scripts/native-ingress-proof.ts`, `scripts/ingress-fixtures/native-entry.ts`, `scripts/d1-ingress-storage-proof.ts`; modify `scripts/native-image-proof.ts` for durable acceptance/polling, `package.json`, `docs/deployment.md`.

**Interfaces:** Exercises complete emitted Worker/private signed route/native provider projection. Storage probe accepts an explicitly isolated D1 test target only; it has no production database default.

- [x] **Step 1: Write actual emitted assertions before adjusting proof integration.** Build fixture from existing image proof module-manifest loader; do not bundle/import a second runtime. Add actual submission-count and original receipt assertions across dispatch response loss/reconstruction. Poll durable statuses/provider boundaries rather than assuming HTTP200 means preparation finished.

```ts
const interruption = interruptAt('ready-before-native'); // arm before enqueueing
assert.equal(await signedSlackPost(event), 200);
assert.equal(await primaryCount('slack_ingress'), 1);
await interruption.reached;
await reconstructWorkerAndRecover();
await waitForNativeSettlement();
assert.equal(await nativeAdmissionCount(event.event_id), 1);
assert.equal(await nativeAnswerCount(event.event_id), 1);
assert.equal(await primaryProducerCount(event.event_id), 0);
assert.ok(capturedProviderRequestHasExactImageBytes(event.event_id));
```

`interruptAt` is armed before the POST and resolves its reached barrier when the persisted boundary is reached. Reconstruction then tears down the interrupted fixture Worker without leaving a hung promise. This is test-fixture-only fault injection, not a production RPC or override of native alarms. Repeat at original native acceptance before receipt persistence, acknowledged event before recovery, lease publication race and ack response loss. Verify fresh unrelated submissions still load fresh context, while replay uses old frozen context. Assert public native methods remain unreachable with zero namespace accesses. Fixture admission counts map the scoped event key to the actual native submission; producer counts map it to the canonical ingress id, not to an invented producer event_id column.

- [x] **Step 2: Run proof after fresh emitted build.** Expected RED against current HTTP200 synchronous proof assumptions until complete durable integration. Every final proof has outbound service allowlist and fake model/Slack values, never real credentials.

- [x] **Step 3: Add large-request and D1 binding proof.** Test twelve1MB-or-smaller BLOB chunks through real Miniflare D1, exact UTF-8 bytes and whole SHA256. Validate memory/query counters and missing/corrupt fail-closed behavior. Confirm Worker request/body/storage limits separately from native request limits.

Implement isolated capacity script with explicit target argument and allowlist/safety check rejecting known production `hatchery-skills` / database ID `6ac5de79-a8c0-4e08-aab8-b9b636278a9d`. No auto-create or remote default. Before any remotely authorized probe, require an explicitly provisioned disposable D1 target. Exercise actual Worker binding BLOB writes/reads and event-plus-producer acceptance through an isolated minimal probe Worker; Wrangler SQL literals alone do not prove binding serialization or webhook latency. The probe artifact has a separate allowlisted Worker name/config, no production DO/Sandbox bindings and no real model/Slack credentials; provisioning or deploying that probe requires the explicit isolated-target authorization. Record target identity, schema/artifact digest, request/chunk sizes, query/memory counters, raw durations and request/reassembly hashes.

Measure signed HTTP acceptance separately from near-limit request storage/readback over at least 20 trials, including concurrent duplicate events and response loss. The acceptance gate is every measured successful HTTP response below Slack's 3-second window for the declared test conditions; report distribution and failures without claiming a universal SLA. Record preparation storage latency and whole-request timeout/memory headroom. Record projected retained payload volume and remaining isolated and production DB headroom from authorized observations; a cap or latency failure holds promotion.

Insert uniquely scoped test rows, reassemble/digest/read back, save metadata-only evidence and delete only probe-owned rows after readback. Test target rejection before the first mutation and cleanup interrupted/resumed under the same probe ID. Do not deploy the app or apply production migrations as a capacity test.

If no isolated remote target is authorized, record remote capacity/latency as **blocked**. Local success cannot satisfy this production gate. Do not reduce supported image sizes, add R2, or waive tests silently.

- [x] **Step 4: Run final local gates in this order.**

```bash
npm run typecheck
npm test
npm run test:native-image
npm run test:native-ingress
npm run test:cutover-native-canary
MOREHANDS_BUILD_CUTOVER=fenced npm run build
npx tsx scripts/check-cutover-config.ts --mode fenced --runtime 2.2.2 --config dist/hatchery/wrangler.json
npx wrangler deploy --config dist/hatchery/wrangler.json --dry-run --containers-rollout=none
git diff --check
```

Add `test:native-ingress` to package scripts as `npm run build && tsx scripts/native-ingress-proof.ts`; it deliberately rebuilds ordinary, so final fenced build follows. Expected local gates exit0; existing warning classifications and each proof's limits recorded, no container-rollout claim.

- [x] **Step 5: One independent whole-change review through opencodex after approved execution completes.** Use the human's named `devin/claude-sonnet-5-5` review choice, or an authorized OpenAI/ZAI model. Include schema trigger/lease/chunks/ack/counter/native proof and all uncommitted prior-work separation. Grade by user effect; one Critical/Important RED→GREEN fix pass; deferred Minors remain explicit. The completed written-plan review is not this future implementation review. No second reviewer for this plan's fix pass. Completed by the authorized ZAI reviewer after the named backend disconnected; the lead's single I1–I3 fix pass completed on 2026-10-05. The raw report's remote-probe scope gap remains blocking production.

- [x] **Step 6: Update deployment procedure and ledger; stop for operational gates.** Document additive0033 backup/order/fence requirements, ingress privacy retention, acknowledgement uncertainty, exact replay, failure disposition, isolated storage proof and metadata readback. No automatic deployment, commit, push or archive.

Required before production promotion: reviewed local implementation; isolated actual D1 capacity/latency proof; approved additive migration with backup; reflection query repair separately verified/approved if scheduled reflection will resume; historical bare-image obligations disposition; fresh fence/fleet/product/delivery evidence; exact reviewed fenced artifact; flash-only live pixel+metadata canary; final controlled reopen/rejection reconciliation. Existing production authorization remains gated and stops on failed safety evidence. Plans archive only after verified completion.

## Test helper contracts

All helpers below are planned test code, created after execution approval. An absent helper is not evidence of a product defect. First add compiling scaffolds, then demonstrate behavior RED against the unsafe implementation before recording final RED evidence.

| Helper | Defined behavior and owner |
|---|---|
| `ingressDbFixture(state)` | Task1 test-utils/ingress-db; applies every actual migration in sorted order, enables foreign keys, returns db/sql/count/openIntake/closeIntake/dispose and committed-response-loss controls. Fence helpers use revision-aware transitions. `dispose` closes SQL and restores replaced globals; it never means close intake. |
| `verifiedFixture(fields)` | Task1 test-utils; builds original provider JSON with team/event IDs, computes original-byte digest and calls the production safe-field selector. Defaults and scoped key are deterministic. |
| `preparingIngressFixture()` | Task2 test-utils; returns the same DB fixture plus lease/now/maxBlobBytes/chunkCount/expireAndReclaim, and installs valid route/effects/ack prerequisites. Reclaim advances the clock past expiry and obtains a new prepare lease. |
| `largeImageRequest` / `textRequest` | Task2 test-utils; builds actual prepared request shapes from the image adapter, with fixed flash model, legal attachment bytes and trusted context. Add a separately padded valid request exercising the twelfth chunk within the native application reserve; two 4MB images alone may require fewer than twelve. |
| `durableAckFixture()` | Task3 test-utils; returns db/lease/input and an allowlisted fake Slack responder with postCount, committed-post response loss, positive metadata, pagination and malformed/identity-conflict controls. It intercepts actual post/history HTTP, not a stubbed ack decision. |
| `signedIngressFixture()` | Task4 test-utils; extends actual app-loading/HMAC fixture with production prepare/batch DB adapter and postEvent/db counters. AcceptanceEntered/holdAcceptanceCommit/releaseAcceptanceCommit control SQL execution, not response timing sleeps. It can throw on waitUntil registration and retains committed rows. Restores global fetch in dispose. |
| `ingressRecoveryFixture()` | Task5 test-utils; actual SQL consumer fixture plus explicit native boundary double. Implements state/producerCount/closeFence/changePersonalityAndEpoch/preparationCount/trackerSubmissionId and native requests/uniqueAdmissions/acceptThenLoseReceipt controls. Lease clock and complete receipts include acceptedAt. |
| `interruptAt`, `reconstructWorkerAndRecover`, native/provider count helpers | Task6 fixture-only exports; barriers are armed before work starts, actual emitted runtime is used once, durable storage survives Worker reconstruction, and counts inspect native submissions/canonical records. Signed local secrets and network allowlists are fake. |

## Plan Self-Review and Handoff

- Spec coverage: signature/event acceptance Task1/4; immutable chunk publication and retention/abandoned cleanup Task2; acknowledgement and behavior preservation Task3; exact handoff/backstop/cutover Task5; native/crash/capacity/privacy and operational gates Task6.
- Shared interfaces: Task1 DB/lease→Tasks2/3/5; Task2 prepared/frozen request→Tasks3/5/6; Task3 trusted target/ack→Task5; Task4 acceptance→Task5 recovery; Task5 state/counters→Task6 proof. API names above are binding across tasks.
- Tests are behavior assertions on actual SQLite/native where necessary. Focused doubles do not establish production native convergence or remote D1 capacity.
- Production deletion scope is not reused: prior exact reflection marker reconciliation is complete and distinct from this plan.
- Both known corrections are incorporated: published payload retention/guarded abandoned cleanup and migration-0031 transcript deduplication. Additional review corrected the lease phase/token contract, bounded acknowledgment lookup, route/epoch races, completion triggers, BLOB decoding, asynchronous digest helper, waitUntil failure after acceptance, quiet/overhear modes, activity retry overwrite, integrity coverage, query budgets and crash-barrier ordering.
- Installed API checks confirmed the public Flue request/receipt exports, top-level keyed replay boundary, current tracker no-op behavior, existing transcript uniqueness and SQLite fixture locations. Official D1 docs were rechecked on 2026-10-04 for primary reads, transactional batch failure, BLOB serialization and limits. These checks are not remote binding/capacity or runtime completion proof.
- The independent Sonnet plan review found no Critical issues. Lead verification incorporated retry fairness/caps, an ingress hint, prompt handoff, shared invocation budgets, timestamp-bounded ack repair, positive rate-limit retry and narrower quiet-content retention. Two reviewer Slack assumptions were checked against official docs/current code. The quiet-content policy is proposed for human review; retention of referenced bytes remains conservative. Raw review and lead disposition are preserved separately.
- Centaur at `21f8aa2f4bcbb99ad1ec9bb25d452f8ad608fb65` reinforces stable message/execution identities and separate delivery recovery. Its inspected background retry is not a durable verified-webhook crash proof. Keep the approved native Flue boundary and current answer outbox; do not copy another execution engine or timer-based ownership. Scoped transcript uniqueness already exists in migration0031, so no additional marker table is needed.
- Written-plan review is required before implementation. Recommended execution is Native/inline with one final independent opencodex whole-change review using the human's Sonnet review exception or an authorized OpenAI/ZAI model: tasks share the same state machine and immutable request, so one continuing context avoids repeated integration drift. This is a recommendation, not an execution choice made for the human.

## Review sources

- [D1 batch and primary binding behavior](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 BLOB binding and result representation](https://developers.cloudflare.com/d1/worker-api/)
- [D1 storage, row and invocation limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Slack replies time-range pagination](https://docs.slack.dev/reference/methods/conversations.replies/)
- [Slack rate-limit response and Retry-After](https://docs.slack.dev/apis/web-api/rate-limits/), [post error codes](https://docs.slack.dev/reference/methods/chat.postMessage/)
- [Centaur scoped message/execution uniqueness](https://github.com/paradigmxyz/centaur/blob/21f8aa2f4bcbb99ad1ec9bb25d452f8ad608fb65/services/api-rs/crates/centaur-session-sqlx/migrations/0005_session_handoff_idempotency.sql), [stable execution key](https://github.com/paradigmxyz/centaur/blob/21f8aa2f4bcbb99ad1ec9bb25d452f8ad608fb65/services/slackbotv2/src/session-api.ts#L1421), [delivery replay](https://github.com/paradigmxyz/centaur/blob/21f8aa2f4bcbb99ad1ec9bb25d452f8ad608fb65/services/slackbotv2/src/index.ts#L2034), [background retry](https://github.com/paradigmxyz/centaur/blob/21f8aa2f4bcbb99ad1ec9bb25d452f8ad608fb65/services/slackbotv2/src/index.ts#L1106).
- Local installed `@flue/runtime@2.2.2`: `dist/index.d.mts` public exports, `dist/types-B1PuLhZt.d.mts:287-345`, `dist/index.mjs:55-73`, keyed comparison in `dist/conversation-stream-store-2-jUriih.mjs:4950-4989`.
- Local `migrations/0031_messages_delivery_id.sql`, `src/slack/delivery.ts:39-59`, `src/slack/reconcile-post.ts`, `src/slack/activity.ts`, `src/knowledge/reflection.ts:23-53`, `src/cutover/test-fixtures.ts`, `src/cutover/ingress-test-fixture.ts`.

## Execution notes — 2026-10-04

Approval and the pre-execution source hashes are retained in the cutover ledger and
`durable-intake-execution-before.json`. Existing image repair and cutover work remain uncommitted.

The implementation adds `file_effects_json` and `file_effect_cursor` to the inbox to checkpoint
bounded file grants across Worker invocations. They are cleared with the extra event copy on quiet
completion. Frozen persona is passed into context preparation to avoid reloading or changing that
identity; legacy soul assignment happens before route selection. This retains the reviewed state
machine and native request rather than introducing another execution subsystem.

Local diagnostics validate at most one outstanding published request per status call. More than
one explicitly reports incomplete hash coverage; SQL metadata counts alone never certify bytes.
Cleanup reserves each whole candidate including deletion and readback before reading its chunks.
Three near-limit abandoned attempts fit in 49 statements; remaining attempts resume on a later
invocation. Cleanup remains an explicit separate operation, with referenced/failed payloads retained.

Targeted SQL, HTTP, acknowledgement, recovery, guarded-effect and query-budget checks pass. The
registered suite passed 1146 tests with zero failures across 79 summaries before the runtime-proof
pass. These are local checks; emitted runtime proofs, independent implementation review, isolated
remote D1 proof and all production gates remain to be recorded. Checkboxes requiring those later
gates intentionally remain open.

Final local sequence passed with 1147 tests/zero failures, fresh typecheck, native image proof,
native ingress crash/replay proof, physical alarm canary, fenced build/config guard, deployment
dry run with container rollout disabled, and diff check. Native runtime testing found and fixed
committed acknowledgement-save response loss with a 11pass/1fail→12pass/0fail regression.
Evidence is in `durable-intake-gates-*.log` and `durable-intake-final-gates-before-review.json`.

The local D1 binding probe passed 36 signed acceptance measurements (max8.674208ms for the
declared local conditions) and exact near-limit twelve-chunk UTF-8 replay. Platform Worker memory,
remote acceptance/storage latency, disposable-target deployment, remaining database headroom,
and interrupted remote-probe resume are not implemented or verified by the local-only script.
Its production-target rejection exits before any network or mutation. Task6's remote storage
step stays open; an isolated target and a true remote probe are still needed before promotion.

Some new test files were authored after initial integration; the earlier RED-authoring chronology
checkboxes are not retroactively declared complete. Concrete acceptance, acknowledgement,
diagnostic, retention, aggregate-budget and emitted-runtime failures/repairs are retained in the
separate logs. Current behavioral proof and implementation-review gates determine local readiness.

The named Sonnet implementation-review attempt disconnected before producing a report. The
authorized ZAI-through-opencodex fallback completed one whole-change review after its provider reset.
Its raw report is retained; three Important findings entered the lead single fix pass. No automated feedback
grants production authority. All production cutover plans remain active and unarchived.


### Independent implementation review and 2026-10-04 safety stop

The raw report is `zai-durable-implementation-review.md` in the cutover evidence directory.
The reviewer independently verified all228 source hashes and historical evidence preservation.
No Critical finding was established; three Important findings were reproduced locally.

I2: required primary binding/context read failures now propagate in durable preparation, which defers
with retained route, producer and confirmed ACK rather than freezing missing context or permanently
failing accepted work. Legacy callers keep their existing fallbacks. Five signed-HTTP fault cases
(binding, catalog, personality, memory, connections) pass recovery with one ACK, one native admission,
unchanged identity/route and producer release only after positive completion. Explicit confirmed
absence and route conflict remain permanent validation rejections.

I3: a bounded metadata search with a remaining cursor cannot confirm a unique ACK. Helper and
durable-ACK regressions pass while retaining uncertainty and making exactly two history requests
with no repost. Saved RED→GREEN logs are `durable-intake-review-*-{red,green}.log`.

I1: the populated aggregate cron gate fails. The registered hard-binding regression retains ingress
identity, manifest/content and its producer but refuses statement51. Production promotion and the
local implementation acceptance checkbox stay open. The separately written
`2026-10-04-reconciliation-budget-adjustment.md` proposes reservations and fair bounded recovery
within the existing cron; human review precedes modifications to legacy reconcilers. No budget
ceiling, cron behavior or legacy recovery loop was silently changed.

Post-fix emitted proofs and a new fenced artifact are held behind this failed safety gate. The earlier
passing runtime/build evidence is preserved and describes its earlier source snapshot. The remote
probe interface, actual disposable D1 capacity/latency/memory/headroom and all production gates
remain unfinished. Nothing is deployed, committed, pushed or archived.

Fresh post-fix typecheck passes. All79 registered test commands ran individually:1155passed/1failed,
with the populated-cron budget regression as the sole failure. Whitespace check passes. Per-command
results and current source/preservation hashes are in `durable-intake-review-fixes-*.json`.

### 2026-10-05 approved budget adjustment and local acceptance

The human approved `2026-10-04-reconciliation-budget-adjustment.md`; the lead implemented it
inline to complete I1 in the existing single fix pass. Whole-operation reservations, protected
readback/release slots, sequential phases and rotating first access enforce the shared conservative
50-statement bound before effects. Existing record limits stay maxima; insufficient room leaves
durable work for a later invocation. Each phase gets first access once per four healthy two-minute
ticks, an opportunity within about eight minutes rather than a backlog completion guarantee.

Fresh local validation passed: typecheck, 1167tests/0failures across80 registered summaries, emitted
native image and ingress crash/replay proofs, physical native alarm canary, local D1 binding probe,
final fenced build/config guard, deployment dry-run with container rollout disabled, and diff check.
Hard-binding tests cover populated stale runs, timeouts, notifications, reply delivery/finalization,
review watermark protection, parallel coding and lost readbacks, exact twelve-chunk frozen replay,
and all four first-access ticks, without issuing statement51 or releasing ambiguous ownership.

The raw independent report and earlier stop/failure logs remain unchanged. Fresh source/artifact
digests, all46116 historical evidence checks and both original ledger-prefix checks are recorded
separately in `reconciliation-budget-final-{gates,preservation}.json`; the lead disposition is
`reconciliation-budget-review-fix-disposition.md`. Task6Step5 is locally complete. Task6Step3 remains
open: a true remote probe interface, authorized disposable target, capacity/latency/platform-memory
and headroom evidence are still required. No production migration/deployment/reopening, live model
or Slack call, commit, push or archival occurred. All cutover plans remain active.


2026-10-05 actual remote Step3 evidence: explicit disposable probe089d762ab53ce401 and
DB0489de51-ae71-41c0-9580-94a91a604217 applied all migrations through0033 with the real remote
Wrangler migration tool. Original0033 remote CASE-trigger parser failure was reproduced by read-only
EXPLAIN; unchanged predicates moved to WHEN, focused78/0 and bounded independent flash/ZAI review
confirmed equivalence. Failed target and original migration bytes retained as evidence.

Actual remote Worker-binding trials:41 signed successful acceptance measurements, max350.692ms;
20 near11.495886MB UTF8 frozen requests with12<=1MBchunks, wholeSHA and byte-identical replay;
concurrent duplicate acceptance and committed reply loss; missing/corrupt storage retained ownership.
Cloudflare GraphQL sampled memoryP99998,056,780bytes, conservative128MB limit leaves29,943,220bytes
at that sampled quantile (sample interval1.0603448); exact peak and full application memory are not
claimed. Probe cleanup lost its first committed reply, then same-ID retries confirmed0events/producers/
chunks/manifests and13 original guards restored. Maximum whole-invocation statements34, below50.

Read-only DB observations and projections recorded before cleanup: isolated231,133,184bytes,
production851,968bytes; conservative500MB allowance leaves499,148,032 production bytes. Measured
worst-case retained growth supports43additional largest requests before other growth. Published
native payloads remain retained indefinitely. Paid capacity is unverified, so do not claim10GB,
unlimited retention or an automatic purge. This is empirical proof under declared conditions, not a
universal SLA, exact memory peak, fleet/delivery certificate or permission to reopen.

Evidence: .superpowers/sdd/2026-10-01-flue-cutover-safety/production-finish-remote-proof-summary.json,
remote-probe-089d762ab53ce401/results-0141-ef94434d55bf31e0.json and append-only state snapshots,
final-capacity-memory-headroom-before-cleanup.json; remote-parser-fix-zai-flash-review.md and
remote-parser-minimal-readonly-reproduction.json in the failed-probe directory.
Production cutover, historical bare-image disposition, live metadata/flash image canary and
reopening remain separately gated. Keep this plan active until that verified completion.
