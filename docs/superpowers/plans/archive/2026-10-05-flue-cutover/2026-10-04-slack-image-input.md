# Slack Image Input Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development after the user reviews this plan and authorizes execution. Steps use checkbox syntax for tracking. This is a local-only plan; no task authorizes production completion or archival.

**Goal:** Repair native image turns without changing engagement, current project context, trusted event identity, destination, or recoverable final delivery.

**Architecture:** One shared decoder reconstructs product delivery state from the existing signal attributes or a gateway-owned versioned user envelope. Native user attachments provide image content; native Flue retains execution/join/recovery ownership and the existing Slack outbox retains external delivery ownership. First characterize the unchanged emitted Worker’s private admission boundary and native image projection. Then implement the decoder and require the same actual-Project harness to turn its context/tool assertions GREEN; no extension hook is assumed to substitute delivery state.

**Tech Stack:** TypeScript, Hono, D1/SQLite, Cloudflare Workers/Durable Objects, Flue runtime/Vite 2.2.2, existing tsx test runners, installed Miniflare/esbuild, fake Slack responses and valid image fixtures.

**Spec:** `docs/superpowers/specs/2026-10-04-slack-image-input-design.md` — user approved local implementation planning on 2026-10-04, contingent on the native source check. This plan is not implementation authorization.

## Global Constraints

- Keep native Flue 2.2.2 responsible for admission, persistence, joining, execution, and recovery.
- Keep the existing Slack uncertainty-aware outbox responsible for external final delivery.
- Do not add a second agent runtime, model queue, receipt-clock redispatch, or custom execution retry.
- Preserve `Project`, `FlueProjectAgent`, `FLUE_PROJECT_AGENT`, dependency pins, unrelated changes, and existing plans/evidence.
- All implementation verification is local, with fake Slack responses, valid image fixtures, and a stub provider.
- No real model calls, real Slack posts, remote state reads/writes, deployment, migration application, commits, pushes, or plan archival.
- A separately authorized live canary must use only `zai/glm-5.3-flash`.
- Credentials stay in Worker environment bindings; neither model content nor diagnostics may contain their resolved values.
- Do not blindly retry ambiguous admission, delete its event claim, or reconstruct an idempotent request from refreshed state.
- Do not replace the SDK alarm or native supervision; add no production test methods or direct internal-store writes.
- Delegation uses OpenAI or ZAI through opencodex, with `model: "haiku"` as the explicit routing placeholder. No Anthropic subagents.
- Work only in the existing cutover worktree. Do not create, merge, remove, clean, or reset a worktree.

## Review Focus

1. A user-envelope-shaped string inside Slack text must not become trusted metadata; test a forged nested snapshot/event/destination in Task 2.
2. Busy joined input must use its own admitted context without borrowing an old receipt, while final delivery remains grouped by native response; test image/text joins and quiet joins in Tasks 3 and 6.
3. History authorization must not convert an arbitrary model-supplied file ID into channel access; test same-channel history grant and cross-project/channel denial in Task 5.
4. A stream exceeding its cap or redirect leaving Slack must be canceled without forwarding credentials; test chunk accumulation, redirect headers, and timeout in Task 4.
5. Malformed or historical image input must not fall back to stale creation context or manufacture terminal delivery; test inert malformed Project rendering and explicitly unresolved legacy correlation in Tasks 2 and 3.

## Workspace and task boundaries

Use the existing tree `.claude/worktrees/agent-a407f7bbfb80d60f3`, branch `flue-2-spike`. Commands below run from that tree; prefixing them with `npm --prefix` does not change a script's path assumptions for direct tsx commands. Check `git status --short` before execution and preserve all pre-existing changes.

Create a separate ignored execution ledger for this plan using the execution skill's workspace script. Do not reuse/delete the cutover-safety workspace. This planning stage does not create an execution ledger or run product tests, build, install packages, or contact any service.

Tasks 1–3 form the atomic input/delivery repair. Tasks 4–5 prepare safe media and restore bounded history, and Task 6 connects/verifies them. An executor must not call the repair complete after only the decoder or mocked ingress test is green.

| File | Responsibility |
|---|---|
| `src/agent/delivery.ts` (new) | Pure trusted logical contract, native envelope construction, strict decode/event extraction |
| `src/agent/delivery.test.ts` (new) | Text/image parity, spoofing, malformed/foreign context, scope/epoch |
| `src/gateway/dispatch-message.ts` | Native message construction through the contract |
| `src/agent/project.ts` | Consume decoded state before model, tools, prompt |
| `src/agent/context.ts` | Context validation; preserve legitimate existing signal fallback only |
| `src/slack/delivery.ts` | Admission-event extraction for both native variants |
| `src/slack/file-authorizations.ts` | Existing file authorization plus bounded vision result |
| `src/slack/vision-media.ts` (new) | Bounded network/media preparation, omissions, no D1 schema changes |
| `src/slack/vision-media.test.ts` (new) | Real stream/redirect/MIME/budget behavior with injected fetch |
| `src/slack/events.ts`, `src/slack/threads.ts` | Safe file metadata and bounded history references |
| `src/gateway/dispatch.ts` | One snapshot/model, capability before download, one native request |
| `src/app.ts` | File-aware engagement, verified history authorization, candidate composition |
| `src/cutover/ingress-test-fixture.ts` | Test-only captured dispatch requests and configurable Slack history/media |
| `scripts/image-fixtures/`, `scripts/native-image-proof.ts` (new) | Local actual emitted-Worker/provider-content proof |
| `package.json` | Explicit test/proof commands; no dependency change |

## Task 1: Prove the native integration and admission boundary

**Files:**
- Create: `scripts/native-image-proof.ts`, `scripts/image-fixtures/native-entry.ts`, `scripts/image-fixtures/provider-response.ts`.
- Reuse: `scripts/cutover-native-canary.ts`, `scripts/cutover-fixtures/native-entry.ts` bundling/persistence patterns.
- Add: `package.json` script `test:native-image`: `npm run build && tsx scripts/native-image-proof.ts`. Every proof run consumes a fresh emitted artifact; no implicit reuse of an older build.
- No retained product adapter changes in this task.

**Interfaces:**
- Consumes the freshly emitted `dist/hatchery/wrangler.json` and its actual exported `FlueProjectAgent`/Worker.
- Produces local characterization: public route denial with zero namespace accesses; actual flash-model request containing valid native image content; current Project context/tool misclassification recorded as RED; producer provenance inventory; pinned size-limit inventory. Full proposed-envelope exposure/acceptance is tested after Task 2 changes the actual consumer, not through an invented hook.
- Provider response is an external network double, not a mocked dispatch or mocked Project.

- [ ] **Step 1: Establish clean scope and baseline.**

Run:
```sh
git branch --show-current
git status --short
npm test
npm run typecheck
```
Expected: branch `flue-2-spike`; pre-existing work preserved; all tests pass and typecheck exits 0. Record actual counts/warnings, not inherited counts. Stop on unknown failures.

- [ ] **Step 2: Add a valid image fixture and test-only provider responder.**

Use this 1×1 RGB-red PNG with valid chunk CRCs and decompressed scanline `00 ff 00 00`, not `[137,80]` or arbitrary single bytes:
```ts
export const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
```

The local outbound double accepts only `https://api.z.ai/api/coding/paas/v4/chat/completions` with JSON model `glm-5.3-flash` and explicitly simulated Slack calls from the fixture. Capture provider JSON, assert `stream === true`, and return `text/event-stream` ending `[DONE]`; the pinned Z.ai OpenAI-completions adapter always requests streaming. A nonstream completion JSON is not a sufficient double. Throw on every other URL/model. Production provider registration stays unchanged; do not initialize a separate `setProvider()` runtime copy. Supply only fake local API/token values and never log Authorization headers.

Return this deterministic SSE response:
```ts
const chunk = (delta:Record<string,unknown>, finish_reason:string|null) => ({
  id:'local-image-answer', object:'chat.completion.chunk', created:0, model:'glm-5.3-flash',
  choices:[{index:0,delta,finish_reason}],
});
const events = [chunk({role:'assistant',content:''},null),
  chunk({content:'local image answer'},null), chunk({},'stop'),
  {...chunk({},'stop'),choices:[],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}];
const sse = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
const response = new Response(sse,{headers:{'content-type':'text/event-stream'}});
```
The proof must honor what the provider actually requests rather than ignoring streaming.

- [ ] **Step 3: Drive the actual emitted Project using the supported private dispatch path.**

Build fresh with `npm run build`, then use the existing Miniflare canary's module-map approach. Keep emitted modules un-rebundled. New temporary persistence must not use `.wrangler` or any production namespace configuration.

Drive the emitted Worker’s existing Slack event ingress with locally signed fixture requests; use its real signature verification, app producer, and native dispatch. Fake only Slack history/ack/files APIs and the external Z.ai response through outboundService. The test entry imports the emitted Worker and re-exports its actual Durable Object classes. Bind `FLUE_PROJECT_AGENT` and `FLUE_REGISTRY` to those emitted classes, with local D1/KV and fresh persistence; the old canary’s `TEST_AGENT` alone cannot exercise dispatch. Do not import source Project/dispatch into this entry or initialize a second Flue registry. Fixture-only routes may read bounded evidence, but may not bypass intake or rewrite Project’s delivery.

Seed an active local binding and necessary schema via Miniflare D1. Send a creating text turn, wait for its actual native submission to settle, then update the local personality/context and send the image turn in the same conversation. Use `zai/glm-5.3-flash` in both snapshots and distinguish staleness with `creation-personality`/`fresh-personality` and literal tool names. Do not claim this two-turn fixture tests a model change: a busy joined turn cannot switch the current submission’s host model. Use fake token references and a fake Slack signing secret; load no deploy env files.

Assertions belong in the runner:
```ts
assert.equal(publicResponse.status, 404);
assert.equal(publicResponse.headers.get('x-local-namespace-accesses'), '0');
assert.equal(capturedProviderRequest.model, 'glm-5.3-flash');
const imageParts = capturedProviderRequest.messages.flatMap((message: {content:unknown}) =>
  Array.isArray(message.content) ? message.content.filter((part: {type:string}) => part.type === 'image_url') : []);
assert.equal(imageParts.length, 1);
assert.equal(imageParts[0].image_url.url, `data:image/png;base64,${PNG_BASE64}`);
const currentSystem = capturedProviderRequest.messages
  .filter((message: {role:string}) => message.role === 'system')
  .map((message: {content:unknown}) => JSON.stringify(message.content)).join('\n');
assert.ok(currentSystem.includes('fresh-personality'));
assert.ok(!currentSystem.includes('creation-personality'));
```
Check the actual tool list: engaged image turns expose `update_status`, not `reply_to_conversation`. Assert literal tool names at the provider boundary, not a test-only effect label. The last three context/tool assertions must fail on the current adapter. Record the failure as the first RED integration evidence.

- [ ] **Step 4: Establish producer provenance and preserve the RED consumer gate.**

Inspect/reject public agent prompt/dispatch methods before namespace access, as the existing alarm canary does. Inventory each internal producer and prove Slack caller JSON stays nested product input, never a directly admitted envelope. Before Task 2, record the proposed envelope’s exact serializable context fields, including token-reference names and product configuration; this is an explicit model-visible exposure tradeoff, not hidden metadata.

No pinned public hook was found that replaces useDelivery/body before unchanged Project’s render. Do not claim a fixture wrapper can decode on Project’s behalf. Keep actual-Project context/tool assertions RED until Task 2 installs the shared contract/consumer. Task 2 then captures the actual provider request to verify exposure and absence of fake resolved credentials. Task 1 may continue only if the emitted trust boundary and native image projection are proven; unacceptable provenance/exposure or a need to patch runtime internals stops execution for spec revision. Do not substitute a D1 cache or split dispatch.

- [ ] **Step 5: Record size and proof limits, then retain only the test harness.**

Inventory the pinned limits and their units: attachment base64 limit 14,680,064 characters; canonical append limit 12,582,912 JSON code units per append batch. Neither is a proven HTTP/admission ceiling, and the user body has no explicit schema cap. Test accepted encoded requests empirically at the actual emitted boundary, including message/envelope, snapshot, attachments, and initialData; repeat with the repaired envelope in Task 2. Record UTF-8 bytes and JSON code units separately. Choose and document an application-safe ceiling only from both the pinned constraints and observed acceptance with headroom. If no safe ceiling can be established, or the 4,000,000-byte raw cap is incompatible, stop for a spec limit correction before Task 4. Do not infer a transport limit from the append cap or claim raw-image size proves acceptance.

Run:
```sh
npm run test:native-image
npm run test:cutover-native-canary
git diff --check
```
Expected: `test:native-image` exits nonzero only at the fresh-context/engaged-tool regression assertions after proving native image projection and private-route denial; record those exact failures as RED. Any earlier harness/API/image/provenance failure blocks Task 2. The alarm canary exits 0 with its narrower scope. Record zero real network/model calls. Keep the RED runner separate from `npm test` until Task 2 repairs the consumer. No commit.

## Task 2: Implement the shared trusted delivery contract and Project parity

**Files:**
- Create: `src/agent/delivery.ts`, `src/agent/delivery.test.ts`.
- Modify: `src/gateway/dispatch-message.ts`, `src/agent/project.ts`, `src/agent/context.ts`, `src/agent/context.test.ts`, `src/gateway/dispatch.test.ts`, `package.json`.

**Interfaces:**
```ts
import type { DeliveredMessage } from '@flue/runtime';
import type { ProjectContext } from './context';
export interface ProjectDeliveryState {
  context: ProjectContext;
  input: Record<string, unknown>;
  engaged: boolean;
  eventId?: string;
  conversationId: string;
  ackMessageTs?: string;
}
export interface ProjectUserEnvelope {
  format: 'morehands.project-input';
  version: 1;
  trusted: {
    instanceId: string;
    snapshot: ProjectContext;
    engaged: boolean;
    eventId?: string;
    conversationId: string;
    ackMessageTs?: string;
  };
  input: Record<string, unknown>;
}
export function decodeProjectDelivery(
  id: string, delivery: DeliveredMessage, initial?: ProjectContext,
): ProjectDeliveryState | null;
export function projectEventId(id: string, delivery: DeliveredMessage): string | undefined;
```
`projectEventId` handles existing signal event attributes without requiring a full render context; user event extraction requires the validated gateway wrapper and instance identity. It must never read nested input.eventId. This preserves existing receipt healing for historical signal admissions with sparse attributes.

The final `projectDispatchMessage` constructor takes instance ID first; every producer/test caller must migrate in this task. Construction owns the top-level wrapper; caller input is nested, never spread into trusted fields. The version literal is internal serialization only.
```ts
export function projectDispatchMessage(
  id: string, input: Record<string, unknown>, snapshot: ProjectContext,
  eventId?: string, images?: Array<{data:string;mimeType:string;filename?:string}>,
): DeliveredMessage;
```

- [ ] **Step 1: Write parity and spoofing tests before changing the producer.**

Use a complete local `ProjectContext` fixture derived from `loadProjectContext` or a literal with all required Binding fields. Use real `agentInstanceId('P','conv:slack:T:C:1')`. For both variants, assert literal expected fields rather than computing one expected decoder result from the other:
```ts
const input = { message: 'describe', conversationId: 'slack:T:C:1', ackMessageTs: 'ack',
  eventId: 'spoofed', attributes: { eventId: 'spoofed', conversationId: 'OTHER' } };
for (const images of [undefined, [{ data: PNG_BASE64, mimeType: 'image/png' }]]) {
  const message = projectDispatchMessage(id, input, current, 'verified-event', images);
  assert.notEqual(typeof message, 'string');
  const state = decodeProjectDelivery(id, message as DeliveredMessage, creation);
  assert.equal(state?.engaged, true);
  assert.equal(state?.context.binding?.model, 'zai/glm-5.3-flash');
  assert.equal(state?.context.personality, 'fresh-personality');
  assert.equal(state?.eventId, 'verified-event');
  assert.equal(state?.conversationId, 'slack:T:C:1');
  assert.equal(state?.ackMessageTs, 'ack');
}
```
Add table cases: malformed JSON; absent version/trusted fields; wrong instance; wrong project/slug; inactive binding; wrong account/channel in a Slack conversation; wrong type for engaged/event/ack; JSON string inside input.message; nested fake snapshot; foreign top-level context. All invalid image envelopes return null, not creation fallback.

Include scope-less legitimate signals and `conv:...~e2` instances so new validation does not silently reject established producers. Engaged user wrappers must name the same conversation as the instance scope, tolerating only the actual numeric epoch suffix. Autonomous signal families retain existing classification and must not expose engaged-only tools.

Run:
```sh
npx tsx src/agent/delivery.test.ts
```
Expected RED initially: missing decoder export; after introducing the API skeleton, assert the current image path fails parity. Correct test setup errors before implementing behavior.

- [ ] **Step 2: Implement constructor/decoder and explicit validation.**

Constructor skeleton:
```ts
const trusted = {
  instanceId: id, snapshot, engaged,
  ...(eventId ? { eventId } : {}),
  conversationId: typeof input.conversationId === 'string' ? input.conversationId : '',
  ...(typeof input.ackMessageTs === 'string' ? { ackMessageTs: input.ackMessageTs } : {}),
};
const body = JSON.stringify({ format: 'morehands.project-input', version: 1, trusted, input });
```
Migrate the existing constructor to the ID-first signature defined above. Update every caller in this task; remove the old signature so no orphan adapter remains. Do not infer instance ID from arbitrary input. Update ignored diagnostic probes only if still used for evidence; preserve their original recorded results rather than changing historical claims.

Signal decode accepts gateway `morehands.input` and preserves previously accepted canonical signal variants only where existing recorded evidence demonstrates legitimate producer input. Parse gateway attributes and validate current context via `projectContextForDelivery`. Preserve the existing creation fallback for legitimate historical signals without snapshot, but do not use it for any user image delivery. Framework hook signals are not product deliveries and must not change the product cursor. User decode requires the exact wrapper shape, validates trusted identity, and never derives engagement/event/destination from nested input. Reject mismatches rather than silently correcting them.

Add pure validation of ProjectContext object structure and relevant Binding/account/channel fields. Do not claim JSON shape is authentication: Task 1 proves producer provenance. User event extraction reuses strict envelope validation rather than parsing event-like text. Historical signal event extraction reads its established trusted attributes after agent/instance/submission checks, without requiring the full render snapshot; preserve the sparse-signal compatibility defined in this task’s Interfaces block.

- [ ] **Step 3: Consume decoded state before model/prompt/tools.**

Replace Project's signal-only expressions with:
```ts
const delivery = useDelivery();
const initial = useInitialData<ProjectContext | undefined>();
const admitted = decodeProjectDelivery(id, delivery, initial);
const context = admitted?.context;
const binding = context?.binding;
useModel(resolveModel(binding?.model));
if (!admitted || !binding || !context) return `No valid admitted input for project "${projectId}". Do not attempt to post anywhere.`;
const { input, engaged, conversationId, ackMessageTs } = admitted;
```
Keep useModel ordering consistent with native hook rules. Returning inert instructions must register no posting tools; malformed input must not expose the autonomous publication path. Do not add a native state store or load D1 asynchronously inside synchronous Project render. Update comments that currently say every input is a signal.

- [ ] **Step 4: Verify actual consumer behavior, not only helper equality.**

Run the existing prompt/self tests, decoder/context/gateway tests, then build fresh and run Task 1’s real native proof against the repaired emitted Project. The runner’s unchanged expected context/tool assertions must turn GREEN. Capture native user content and inventory the envelope’s actual snapshot/token-reference exposure; assert fake resolved credentials are absent. Recheck actual encoded request acceptance/size with the envelope and initialData, not the old bare-input body. Spoofed nested input stays model-visible data without changing trusted tool state. Stop if exposure is unacceptable or the repaired payload cannot establish a safe application ceiling.

Run:
```sh
npx tsx src/agent/delivery.test.ts
npx tsx src/agent/context.test.ts
npx tsx src/gateway/dispatch.test.ts
npm run test:native-image
npm test
npm run typecheck
git diff --check
```
Expected GREEN for former context/tool RED, all suite tests pass, no silent legacy signal regression. Add `tsx src/agent/delivery.test.ts` explicitly to `npm test`. No commit.

## Task 3: Heal lost image receipts through native admission

**Files:** Modify `src/slack/delivery.ts`, `src/slack/delivery.test.ts`.

**Interfaces:** Consume `projectEventId(id,delivery)` from Task 2. `ReplyHistory`, `ReplyAdmission`, tracker schema, outbox API and public final-delivery behavior remain unchanged.

- [ ] **Step 1: Add RED tests for actual admission mapping.**

Extend the existing in-memory SQLite fixture to expose the native storage SQL adapter expected by `nativeReplyHistory`. Create only test native submission tables with pinned required columns; use the real canonical store adapter for history where already tested. Seed an image envelope admission row with the same actual payload fields the local proof emits, without attaching a receipt.

Assertions:
```ts
await seedReplyTracker(f.db, { instanceId, eventId: 'event', target, publish: true });
const h = await nativeReplyHistory(localNativeStorage);
await reconcileReplyHistory(f.db, instanceId, h);
assert.equal(f.sql.prepare('SELECT submission_id FROM slack_reply_trackers').get()?.submission_id, 'host');
assert.equal(f.replies().length, 1);
assert.equal(f.replies()[0].text, 'Recovered image answer');
await reconcileReplyHistory(f.db, instanceId, h);
assert.equal(f.replies().length, 1);
```
Keep the real native admission extractor in the test; a fake `admissions:()=>[...]` alone cannot catch the producer bug. Add pre-canonical settled/unready image row, conflicting tracker mapping, wrong instance/agent/submission identity, and legacy bare-input user body. Legacy user body must not infer verified event ID from `input.eventId`.

Add mixed image/text joined records with one response target and a quiet joined signal. Preserve conflict rejection for different targets. Confirm receipt loss is exercised by not calling `attachReplySubmission` in the test.

Run:
```sh
npx tsx src/slack/delivery.test.ts
```
Expected RED: accepted image admission not mapped, zero staged rows.

- [ ] **Step 2: Use shared verified extraction for both admitted variants.**

Replace the signal-kind filter with:
```ts
if (input.agent !== 'project' || input.id !== instanceId || input.submissionId !== row.submission_id) return [];
const eventId = projectEventId(instanceId, input.message);
if (!eventId) return [];
return [{ eventId, submissionId: String(row.submission_id),
  unreadyTerminal: row.status === 'settled' && row.attempt_id == null && row.canonical_ready_at == null }];
```
Type `input.message` as `DeliveredMessage | undefined` and reject absent/malformed values before extraction. Existing signal recovery must not suddenly require user-envelope format. Admission payload is native durable truth; do not parse arbitrary canonical text as trusted metadata.

Retain the canonical cursor rules and bySubmission mapping after admission healing. Native unready rows without precise outcome remain visibly failed, not falsely aborted/delivered. Do not change target resolution, outbox uncertainty policy, or reply scheduling.

- [ ] **Step 3: Verify GREEN and native recovered settlement.**

Run:
```sh
npx tsx src/slack/delivery.test.ts
npx tsx src/slack/reply-runtime.test.ts
npx tsx src/slack/reply-outbox.test.ts
npm run test:native-image
npm test
npm run typecheck
git diff --check
```
Expected: image lost-receipt stages one final reply; legacy missing-correlation remains unresolved; joined/silent and uncertainty tests unchanged. Extend the native fixture to fail only the local D1 receipt-attachment update after native acceptance, using a test-only D1 binding wrapper; do not invent an onAccepted hook or suppress native dispatch. Reconstruct the temporary instance and reconcile from its actual durable admissions/history. Assert one local outbox reply with no real Slack post. No commit.

## Task 4: Prepare bounded, validated native media with visible omissions

**Files:** Create `src/slack/vision-media.ts`, `src/slack/vision-media.test.ts`; modify `src/slack/file-authorizations.ts`, its test, and `package.json`.

**Interfaces:**
```ts
import type { D1Like } from '../skills/repository';
import type { SlackFileMeta } from './events';
export interface VisionImage { data:string; mimeType:string; filename?:string }
export type VisionOmissionReason = 'unauthorized'|'token-unavailable'|'type-unknown'|'unsupported-format'
  |'mime-mismatch'|'invalid-header'|'too-large'|'turn-budget'|'image-limit'
  |'unsafe-url'|'redirect-limit'|'timeout'|'unavailable'|'native-payload-limit';
export interface VisionPreparation {
  images: VisionImage[];
  omissions: Array<{fileId:string; reason:VisionOmissionReason}>;
}
export async function prepareVisionImages(input: {
  db:D1Like; token:string|undefined; projectId:string; conversationId:string;
  files:SlackFileMeta[]; fetcher?:typeof fetch; timeoutMs?:number;
}):Promise<VisionPreparation>;
```
The optional timeout is injection for bounded network behavior with a sensible production default (5,000 ms), not a production disable switch. Keep `VisionImage` imported/re-exported from one canonical module; do not introduce duplicate exported types in file-authorizations and vision-media. Constants retain the spec's 4,000,000 raw bytes/image, 8,000,000 cumulative candidate bytes, 4 candidates/2 images, 64 KiB files.info and 3 validated redirects, subject to Task 1's verified native payload ceiling. No new database schema.

- [ ] **Step 1: Write RED stream/body validation tests with valid fixtures.**

Use existing authorization fixture with real SQLite. Replace arbitrary-byte accepted fixtures with valid image bytes. The injected fetch returns files.info with exact requested ID and fake Slack HTTPS private URL; assert no download occurs for unauthorized file.

A HTML regression is:
```ts
const result = await prepareVisionImages({ db:f.db, token:'fake', projectId:'P', conversationId:'C',
  files:[{id:'F',name:'pic.png',mimetype:'image/png',size:null}],
  fetcher: async (url, init) => String(url).includes('files.info')
    ? Response.json({ok:true,file:{id:'F',url_private_download:'https://files.slack.com/private/F'}})
    : new Response('<html>not pixels</html>', {headers:{'content-type':'text/html'}}),
});
assert.equal(result.images.length, 0);
assert.deepEqual(result.omissions, [{fileId:'F',reason:'mime-mismatch'}]);
```
Add a real ReadableStream with chunks crossing the cap; track cancellation and accumulation with an injected stream source, not just arrayBuffer size. Add Content-Length absent/understated/overstated, missing event size/MIME, truncated image header, MIME contradiction, matching/octet-stream/absent response type, and valid image formats.

Redirect tests assert a non-Slack redirect target receives zero requests and no Authorization, HTTPS/credentials/port restrictions, relative safe Location resolution, and fourth-hop rejection. Timeout fetch double listens to the received AbortSignal and throws when aborted; assert visible timeout and no subsequent candidate request after the turn deadline. Do not make a never-resolving mock that ignores abort and then claim cancellation.

Run:
```sh
npx tsx src/slack/vision-media.test.ts
```
Expected RED: helper absent, then current HTML/whole-buffer behavior fails once API skeleton exists. No implementation before the behavioral RED.

- [ ] **Step 2: Implement sequential bounded stream reading and validated URL hops.**

Use private `MediaFailure` only to propagate safe categories:
```ts
class MediaFailure extends Error {
  constructor(readonly reason:VisionOmissionReason) { super(reason); }
}
interface ByteBudget { used:number; cap:number }
```
The helper catches only to map known category or `unavailable`, never serializes Error.stack/message from fetch into model input. Abort maps to `timeout` only when the shared deadline controller fired; an unrelated cancellation is not mislabeled.

Core accumulation pattern:
```ts
const reader = response.body?.getReader();
if (!reader) throw new MediaFailure('unavailable');
const chunks: Uint8Array[] = [];
let bytes = 0;
try {
  for (;;) {
    const {done,value} = await reader.read();
    if (done) break;
    const nextBytes = bytes + value.byteLength;
    budget.used += value.byteLength; // Include consumed chunks even when this candidate fails.
    if (nextBytes > cap || budget.used > budget.cap) {
      await reader.cancel();
      throw new MediaFailure(nextBytes > cap ? 'too-large' : 'turn-budget');
    }
    bytes = nextBytes; chunks.push(value);
  }
} catch (error) {
  try { await reader.cancel(); } catch { /* Preserve the original safe failure. */ }
  throw error;
} finally { reader.releaseLock(); }
```
Reject before appending an over-limit chunk. Cancel on abort or parse failure. Combine only retained valid-size chunks; account for base64/encoded native size separately. The shared AbortController timer starts once per preparation and is cleared in finally. Pass its signal to every fetch and stream operation; stop scheduling candidates when aborted or budget exhausted. Map errors to bounded reason categories, never raw private URLs/body/exception text.

URL validation uses `new URL`, `protocol==='https:'`, no username/password, default HTTPS port, and a literal approved Slack-host allowlist verified against fixture/reference behavior. Begin with exact `files.slack.com`; add a host only with source evidence and a matching test, not an unrestricted substring/suffix check. Redirect fetch uses `redirect:'manual'`, validates every Location before the next credential-bearing request, at most 3 hops.

Byte sniffing checks complete PNG signature/header, JPEG SOI/header, GIF87a/GIF89a logical screen header, and RIFF/WEBP header, then uses supported actual MIME. It is not a full decoder. Accept matching response MIME, octet-stream, or absent type; reject HTML/contradictions. Bound files.info JSON before JSON.parse and verify `file.id` matches.

- [ ] **Step 3: Return images and all deterministic omissions; remove orphan helper.**

Candidate ordering is current before history as provided by Task 5. Deduplicate file ID, inspect at most 4 hinted images, retain at most 2 native images. Every eligible omitted reference receives a stable category; unknown type remains a discoverable handle. Empty token yields token-unavailable without network. Count cap does not trigger unbounded failed downloads.

Move only the newly added vision download logic out of file-authorizations into this focused helper; keep existing authorization functions and workspace loading unchanged. Remove the old `fetchAuthorizedVisionImages` export after all callers/tests migrate in Task 6; if it temporarily remains between tasks, mark that transition in the ledger and ensure no second live implementation survives final verification.

Run:
```sh
npx tsx src/slack/vision-media.test.ts
npx tsx src/slack/file-authorizations.test.ts
npx tsx src/workspace/slack-files.test.ts
npm test
npm run typecheck
git diff --check
```
Expected GREEN for media failures, workspace suite unchanged, no dependency/install/schema change. Add new media suite explicitly to `npm test`. No commit.

## Task 5: Restore attachment-only engagement and authorized bounded history

**Files:** Modify `src/slack/events.ts`, `src/slack/events.test.ts`, `src/slack/threads.ts`, `src/slack/threads.test.ts`, `src/slack/file-authorizations.ts`, `src/cutover/ingress-test-fixture.ts`, `src/cutover/ingress.test.ts`, `src/app.ts`.

**Interfaces:**
```ts
export interface ThreadMessage {
  user?:string; bot_id?:string; text:string; ts:string;
  files?:SlackFileMeta[];
}
export interface SlackMediaContext {
  currentFiles:SlackFileMeta[];
  historyFiles:SlackFileMeta[];
  imageCandidates:SlackFileMeta[];
}
export function slackFileMetadata(value:unknown):SlackFileMeta[];
export function slackMediaContext(
  currentFiles:SlackFileMeta[], history:ThreadMessage[], excludeTs:string,
):SlackMediaContext;
```
Normalize file metadata through one existing events helper (`slackFileMetadata(value:unknown):SlackFileMeta[]`) used for event and fetched history, stripping private URLs. Proposed pure helper `slackMediaContext(currentFiles,history,excludeTs)` applies latest-20 history/20 references/current-first dedup/4 candidates. Keep it in threads.ts unless that module becomes unwieldy; do not create a provider framework.

- [ ] **Step 1: Add RED renderer/history tests with literal expected handles.**

```ts
const rendered = renderThreadBackscroll([
  {user:'U',text:'',ts:'1.0',files:[{id:'F',name:'pic.png',mimetype:'image/png',size:null}]},
], 'BOT');
assert.match(rendered, /U/);
assert.match(rendered, /1\.0/);
assert.match(rendered, /F/);
assert.match(rendered, /pic\.png/);
```
Fetched Slack history fixtures include files with `url_private`; assert returned safe metadata has no private URL. Retain existing text-only rendering expectations unless the approved timestamp format requires deliberate update. Test excludeTs, 20-message bound, 20-reference bound, candidate limit, duplicate IDs, current priority, and newest-first source reversal.

Run `npx tsx src/slack/threads.test.ts`; expected RED: image-only rendered empty/files discarded.

- [ ] **Step 2: Add RED actual-ingress engagement/authorization tests.**

Extend ingressFixture with test-only configurable history/private download bodies and captured `ProjectDispatchRequest[]`. Do not use only `effects.includes('native-dispatch-vision')`; inspect the real product request emitted before the mocked external native boundary.

```ts
const body = slackMessage();
body.event.text = '';
(body.event as Record<string,unknown>).channel_type = 'im';
(body.event as Record<string,unknown>).files = [{id:'F',name:'pic.png',mimetype:'image/png'}];
await f.signedSlack(body); await f.finishJobs();
assert.equal(f.dispatchRequests.length, 1);
assert.equal(f.dispatchRequests[0].input.conversationId, 'slack:T:C:1.0');
assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM slack_conversation_files').get()?.n, 1);
```
A bare mention+image similarly dispatches with empty normalized text and nonempty file candidates. An ambient bound-channel image must create authorization but no dispatch/reaction/ack; a later same-thread or same-channel history question must include the earlier file handle. A fetched wrong project/channel history reference must not grant access. Preserve closed-fence tests proving zero file actions and no consuming effects.

Run `npx tsx src/cutover/ingress.test.ts`; expected RED: image-only DM no request; ambient authorization absent.

- [ ] **Step 3: Make engagement and history authorization content-aware, not text-only.**

Engagement change:
```ts
const hasFiles = !!ev.files?.length;
const engaged = mentionsBot(text,binding.transportBotId)
  || isDm && (hasFiles || !isTrivialChatter(text))
  || existingParticipation;
```
Do not make `hasFiles` alone engage channel input. Record verified current file references for both ambient and engaged branches inside the existing producer scope, without moving any action before beginIntake/signature/binding verification. Ensure duplicate ambient events do not repeatedly change transcripts or trigger overhearing.

Preserve safe file metadata in both history fetches. Reuse the same history request for participation/context/media; do not make redundant API calls. Associate authorization with the explicit verified workspace/channel/thread request that fetched the file. Pass current trusted conversation ID to `recordSlackConversationFiles`, never model-supplied lookup scope. Model tool input remains only a request to use an already-authorized ID.

Render stable file handles/omission notices for image-only entries, respecting existing char bound and latest 20 prior messages for media context. Current files and history files remain distinguishable so the model can attribute pixels to the correct author/message.

- [ ] **Step 4: Verify GREEN and scope isolation.**

Run:
```sh
npx tsx src/slack/events.test.ts
npx tsx src/slack/threads.test.ts
npx tsx src/cutover/ingress.test.ts
npx tsx src/workspace/slack-files.test.ts
npm test
npm run typecheck
git diff --check
```
Expected: attachment-only cases dispatch; ambient cases remain silent; earlier scoped handles discoverable; arbitrary/unrelated IDs denied; fence tests unchanged. No commit.

## Task 6: Connect capability-first preparation and prove the complete local boundary

**Files:** Modify `src/gateway/dispatch.ts`, `src/gateway/dispatch-message.ts`, `src/gateway/dispatch.test.ts`, `src/app.ts`, ingress fixture/tests, native image runner, `package.json`. Remove orphan vision producer/helper tests only when their behavior is covered in the new suites.

**Interfaces:** Final trusted request accepts file references, not pre-fetched model-visible bytes from arbitrary request JSON:
```ts
export interface ProjectDispatchRequest {
  agent?:'project'; id:string; input:Record<string,unknown>;
  idempotencyKey?:string; eventId?:string;
  imageFiles?:SlackFileMeta[];
}
```
`projectDispatchMessage(id,input,snapshot,eventId,images)` receives only preparation output owned by dispatchProject. Text/autonomous producers omit imageFiles. The selected model is read from the same `snapshot` placed in the envelope.

Define the pure notice helper in `src/slack/vision-media.ts` and cover it in that suite:
```ts
export function addSafeMediaNotices(
  input:Record<string,unknown>, preparation:VisionPreparation, supportsVision:boolean,
):Record<string,unknown>;
```
It returns a new input object with bounded `mediaNotices` (file ID and enum category), without mutating caller data or spreading trusted fields. If supportsVision is false and input has image references, add one `selected model does not accept images` text notice; do not pretend an automatic caption exists. Extend its result interface explicitly with that fixed text-only capability notice, not arbitrary exception strings.

- [ ] **Step 1: Add RED capability-before-network and omission tests.**

At a real gateway boundary with injected fetch/Worker-env test fixture, set selected catalog metadata to a text-only model without invoking it. Assert no files.info/private download occurs, imageFiles stay represented in input handles, and a model-visible `selected model does not accept images` notice appears. For flash model, use current snapshot with valid image files and assert one native user message plus native images. Do not use a live provider to prove capability.

Inject a preparation failure and assert text admission still includes a safe omission category. Inject snapshot/model mismatch and assert the selected snapshot controls both preparation and Project. Do not hydrate twice or change model after capability decision.

- [ ] **Step 2: Move preparation under the single gateway snapshot.**

Composition shape:
```ts
const snapshot = await loadProjectContext(env, request.id);
if (!snapshot.binding || snapshot.binding.status !== 'active') throw new ProjectAdmissionError('No active project binding');
const model = resolveModel(snapshot.binding.model);
const preparation = request.imageFiles?.length && modelSupportsVision(model)
  ? await prepareVisionImages({db,token,projectId:snapshot.projectId,conversationId,
      files:request.imageFiles})
  : {images:[],omissions:[]};
const input = addSafeMediaNotices(request.input, preparation, modelSupportsVision(model));
const prepared = {
  id:request.id,
  message:projectDispatchMessage(request.id,input,snapshot,request.eventId,preparation.images),
  initialData:snapshot,
  ...(request.idempotencyKey ? {idempotencyKey:request.idempotencyKey}:{}),
};
return dispatch(Project,prepared);
```
Read `db` and token only from Worker env/current binding; conversation comes from trusted producer input validated by Task 2. `addSafeMediaNotices` is a pure helper in delivery/media contract with bounded enum reasons; define/test it in the same task. Do not serialize the token, URL, env, fetch function, or error object.

Remove app's prefetch call and `msg.text` guard. App passes authorized current/history imageFiles plus safe handles. Delete old `images` transport API and obsolete comments/effect-only vision assertions. Only native message construction deals with base64. Unknown native dispatch failures retain current unresolved markers; no new redispatch behavior.

- [ ] **Step 3: Verify native size gate and graceful omission.**

Apply Task 1's verified native encoded-payload ceiling before dispatch. If images make the request too large, deterministically drop lowest-priority image(s), retain handles and `native-payload-limit` omission, and recompute the encoded size; if the text/snapshot alone exceed the limit, reject visibly before native dispatch rather than truncating trusted identity/context. Test this with raw/base64 boundary fixtures. Do not label native-payload rejection as a provider vision failure.

- [ ] **Step 4: Run all fresh final gates.**

```sh
npm test
npm run typecheck
npm run build
npm run test:native-image
npm run test:cutover-native-canary
git diff --check
```
Inspect generated config and exports from this fresh build: public Project transport remains absent; fixture-only entry/provider routes are not production exports; binding/class/generation names remain established. Record actual request/image/context/tool assertions, lost receipt reconciliation after reconstruction, and busy join behavior. The fake outbound service must throw on any unscripted network; no credentials loaded from local deploy env files.

A native interrupted-attempt proof is separate from idle alarm proof. If needed to verify the repair's recovery boundary, interrupt only the temporary local fixture and reconstruct against the same new persistence. Record what was interrupted and which durable admission/history/outbox rows survived; do not claim a restart before/after idle is crash proof.

- [ ] **Step 5: Whole-change review and user handoff.**

One read-only OpenAI/opencodex reviewer checks this repair's diff against spec, task interfaces, trust/exposure evidence, and Review Focus. Preserve the pre-existing cutover diff; reviewer must distinguish changes made by this plan. Confirm any important findings with RED-to-GREEN tests and one inline fix pass, then repeat the full fresh final gates. No commit, push, merge, production check or archive.

Report:
- Verified local behavior and exact test/proof results.
- Model-visible context tradeoff and private-producer proof.
- Historical image admissions still unresolved without trusted mapping.
- KV/unknown-admission suppression and durable three-second webhook handoff remain separate blockers.
- Production cutover/archival remain incomplete until separately authorized verified actions.

## Spec coverage and limits

| Spec requirement | Owning task and evidence |
|---|---|
| Atomic native input, private provenance, model-visible exposure | Tasks 1–2: emitted Slack ingress, public denial, structured provider image blocks, actual envelope inventory |
| Current context/engagement/tool parity; inert malformed input | Task 2: decoder cases and actual Project RED→GREEN |
| Receipt-independent recovery, joined/quiet suppression, legacy obligations | Task 3: real native admission extractor, repeated reconciliation and local reconstruction |
| Attachment-only DM/mention; ambient silence | Task 5: actual app ingress request/authorization assertions |
| Bounded safe history and scoped file grants | Task 5: renderer/history and cross-scope denial cases |
| Capability before media; explicit text-only/omission behavior | Tasks 4 and 6: no-network capability test and bounded notices |
| Valid bytes, safe hosts/redirects, deadline and accumulation caps | Task 4: valid format fixtures, stream cancellation, abort and credential-forwarding checks |
| Encoded native acceptance/size and graceful image omission | Tasks 1–2 and 6: pinned-unit inventory, actual accepted payload and boundary cases |
| Native execution/recovery ownership and unchanged alarms | Tasks 1, 3 and 6: actual runtime bindings/history and separate alarm proof |
| Fresh suite/typecheck/build and whole-change review | Task 6: explicit final commands and one OpenAI reviewer |

No repair task claims to solve durable ingress/frozen keyed replay, Slack’s three-second durable handoff, historical image remediation, production pixel recognition or cutover certification. Those remain explicitly separate; no spec requirement is silently treated as verified by the planning checks.

## Plan review and execution authorization

The read-only native source report is incorporated: no delivery-replacement hook is assumed; the proof drives locally signed emitted Slack ingress with actual Project/registry bindings; Z.ai requires SSE; native size units are not conflated; settlement precedes the second context turn. Task 1 establishes runtime trust/projection and records actual-Project RED; Task 2 supplies the decoder and requires GREEN, actual exposure inventory and encoded-payload acceptance. Any API mismatch, unacceptable context exposure, native payload ceiling conflict, or inability to test actual provider projection is a stop-and-revise gate—not permission to replace Flue or weaken the proof.

Recommend native inline execution with one whole-change OpenAI review because the contract, Project consumer and admission replay share one tightly coupled interface. User review/approval of this written plan and execution choice are still required. No implementation accompanies this plan.
