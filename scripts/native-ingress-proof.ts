import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { providerResponse } from './image-fixtures/provider-response';
import { migrationStatements } from './migration-statements';

const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { build } = require('esbuild');

const configPath = resolve('dist/hatchery/wrangler.json');
const config = JSON.parse(await readFile(configPath, 'utf8')) as { compatibility_date: string; main: string };
const artifactRoot = dirname(configPath);
const temporary = await mkdtemp(join(tmpdir(), 'morehands-native-ingress-'));
const scriptPath = join(temporary, 'entry.mjs');

interface ProviderRequest {
  messages: Array<{ role: string; content: unknown }>;
  model: string;
  tools: Array<{ function: { name: string } }>;
}
interface SlackPost { deliveryId: string; text: string }
interface NativeEvidence { submissionId: string; status: string; eventId?: string }
type InterruptPoint = 'ready-before-native' | 'native-accept-before-receipt' |
  'acknowledged-before-recovery' | 'prepare-lease-competition';

const providerRequests: ProviderRequest[] = [];
const slackPosts: SlackPost[] = [];
const acknowledgedMetadata = new Map<string, { ts: string; user: string; threadTs: string }>();
let loseNextAcknowledgement = false;

await build({
  entryPoints: [resolve('scripts/ingress-fixtures/native-entry.ts')],
  outfile: scriptPath,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  plugins: [{
    name: 'native-artifact',
    setup(builder: any) {
      builder.onResolve({ filter: /^ingress-native-artifact$/ }, () => ({ path: './' + config.main, external: true }));
    },
  }],
});

const modules: Record<string, { type: 'esm'; contents: string }> = {
  'ingress-proof.mjs': { type: 'esm', contents: await readFile(scriptPath, 'utf8') },
};
for (const file of await readdir(artifactRoot, { recursive: true })) {
  if (file.endsWith('.js')) modules[file] = { type: 'esm', contents: await readFile(join(artifactRoot, file), 'utf8') };
}

const options = convertV4MiniflareOptions({
  name: 'local-native-ingress-proof',
  modules: true,
  scriptPath,
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: ['nodejs_compat'],
  durableObjects: {
    FLUE_PROJECT_AGENT: { className: 'LocalIngressAgent', useSQLite: true },
    FLUE_REGISTRY: { className: 'FlueRegistry', useSQLite: true },
  },
  d1Databases: ['DB'],
  kvNamespaces: ['SLACK_EVENTS'],
  resourcePersistencePath: join(temporary, 'sqlite'),
  bindings: {
    CUTOVER_CONTROL: 'd1',
    SLACK_SIGNING_SECRET: 'local-signing',
    KNOWN_TEAM_IDS: 'T',
    SLACK_BOT_ID: 'BOT',
    TEST_SLACK_TOKEN: 'fake-resolved-slack',
    ZAI_API_KEY: 'fake-resolved-model',
    HEARTBEAT_TOKEN: 'fake-local-heartbeat',
  },
  telemetry: { enabled: false },
  outboundService: async (request: Request) => {
    const url = new URL(request.url);
    if (url.href === 'https://api.z.ai/api/coding/paas/v4/chat/completions') {
      const body = await request.json() as ProviderRequest & { stream?: boolean };
      assert.equal(body.model, 'glm-5.3-flash');
      assert.equal(body.stream, true);
      assert.equal(request.headers.get('authorization'), 'Bearer fake-resolved-model');
      providerRequests.push(body);
      return providerResponse();
    }
    if (url.origin !== 'https://slack.com') throw new Error('unscripted outbound origin: ' + url.origin);
    if (url.pathname === '/api/conversations.replies' || url.pathname === '/api/conversations.history') {
      const threadTs = url.searchParams.get('ts');
      const messages = [...acknowledgedMetadata]
        .filter(([, value]) => value.threadTs === threadTs)
        .map(([deliveryId, value]) => ({
          ts: value.ts, subtype: 'bot_message', user: value.user, channel: 'C', thread_ts: value.threadTs,
          metadata: { event_type: 'morehands_reply', event_payload: { delivery_id: deliveryId } },
        }));
      return Response.json({ ok: true, messages, has_more: false, response_metadata: { next_cursor: '' } });
    }
    if (url.pathname === '/api/users.info') {
      return Response.json({ ok: true, user: { id: 'U', name: 'fixture-user', profile: { display_name: 'Fixture User' } } });
    }
    if (url.pathname === '/api/chat.postMessage') {
      const body = await request.clone().json() as {
        thread_ts?: unknown;
        text?: unknown;
        metadata?: { event_type?: unknown; event_payload?: { delivery_id?: unknown } };
      };
      assert.equal(request.headers.get('authorization'), 'Bearer fake-resolved-slack');
      const deliveryId = body.metadata?.event_payload?.delivery_id;
      assert.equal(body.metadata?.event_type, 'morehands_reply');
      assert.equal(typeof deliveryId, 'string');
      assert.equal(typeof body.text, 'string');
      const record = { deliveryId: String(deliveryId), text: String(body.text) };
      slackPosts.push(record);
      if (record.deliveryId.startsWith('ingress-ack:')) {
        assert.equal(typeof body.thread_ts, 'string');
        acknowledgedMetadata.set(record.deliveryId, {
          ts: (acknowledgedMetadata.size + 100) + '.0', user: 'BOT', threadTs: String(body.thread_ts),
        });
        if (loseNextAcknowledgement) {
          loseNextAcknowledgement = false;
          throw new Error('fixture lost acknowledgement response');
        }
      }
      const known = acknowledgedMetadata.get(record.deliveryId);
      return Response.json({ ok: true, ts: known?.ts ?? (slackPosts.length + 10) + '.0', channel: 'C' });
    }
    if (url.pathname === '/api/chat.update' || url.pathname === '/api/reactions.add' || url.pathname === '/api/reactions.remove') {
      return Response.json({ ok: true });
    }
    throw new Error('unscripted local Slack request: ' + url.pathname);
  },
});
options.workers[0].config.manifest = { mainModule: 'ingress-proof.mjs', modulesRoot: artifactRoot, modules };

let mf = new Miniflare(options);
let db = await mf.getD1Database('DB') as D1Database;

async function migrate(): Promise<void> {
  for (const file of (await readdir(resolve('migrations'))).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await readFile(resolve('migrations', file), 'utf8');
    const statements = migrationStatements(sql);
    await db.batch(statements.map(statement => db.prepare(statement)));
  }
}

async function reconstruct(): Promise<void> {
  await mf.dispose();
  mf = new Miniflare(options);
  db = await mf.getD1Database('DB') as D1Database;
}

function signedHeaders(raw: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', 'local-signing').update('v0:' + timestamp + ':' + raw).digest('hex');
  return { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': 'v0=' + signature };
}

async function signedSlackPost(eventId: string, text: string, root: string): Promise<Response> {
  const markedText = text + ' [proof:' + eventId + ']';
  const raw = JSON.stringify({
    type: 'event_callback', team_id: 'T', event_id: eventId,
    event: { type: 'message', channel: 'C', user: 'U', ts: root, thread_ts: root, text: markedText },
  });
  return mf.dispatchFetch('https://local/slack/events', { method: 'POST', body: raw, headers: signedHeaders(raw) });
}

async function internalReconcile(): Promise<Response> {
  return mf.dispatchFetch('https://local/__internal/slack-ingress/reconcile', {
    method: 'POST', body: '{}',
    headers: { 'x-morehands-token': 'fake-local-heartbeat', 'content-type': 'application/json' },
  });
}

async function interruptAt(point: InterruptPoint): Promise<{ reached: Promise<void>; release: () => Promise<void> }> {
  const armed = await mf.dispatchFetch('https://local/fixture/interrupt', {
    method: 'POST', body: JSON.stringify({ point }), headers: { 'content-type': 'application/json' },
  });
  assert.equal(armed.status, 200, await armed.clone().text());
  let stop = false;
  let reachedResolve!: () => void;
  let reachedReject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    reachedResolve = resolve;
    reachedReject = reject;
  });
  const timeout = setTimeout(() => {
    stop = true;
    void (async () => {
      try {
        const disarmed = await mf.dispatchFetch('https://local/fixture/disarm', { method: 'POST' });
        assert.equal(disarmed.status, 200, await disarmed.text());
      } catch (error) {
        reachedReject(error);
        return;
      }
      reachedReject(new Error('fixture barrier timeout after 30 seconds: ' + point));
    })();
  }, 30_000);
  void (async () => {
    while (!stop) {
      try {
        const state = await (await mf.dispatchFetch('https://local/fixture/barrier')).json() as { point: string | null; reached: boolean };
        if (state.point === point && state.reached) {
          clearTimeout(timeout);
          return reachedResolve();
        }
        if (stop) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      } catch (error) {
        if (stop) return;
        clearTimeout(timeout);
        reachedReject(error);
        return;
      }
    }
  })();
  return {
    reached: promise,
    release: async () => {
      stop = true;
      clearTimeout(timeout);
      const released = await mf.dispatchFetch('https://local/fixture/release', { method: 'POST' });
      assert.equal(released.status, 200, await released.clone().text());
    },
  };
}

async function row(eventId: string): Promise<any> {
  return db.prepare('SELECT * FROM slack_ingress WHERE team_id=? AND event_id=?').bind('T', eventId).first();
}

const nativeRoots = new Map<string, string>([
  ['ready-loss', '1.0'], ['fresh-context', '2.0'], ['receipt-loss', '3.0'],
  ['ack-committed', '4.0'], ['lease-race', '5.0'], ['ack-response-loss', '6.0'],
]);
let nativeEvidenceCache: NativeEvidence[] = [];
async function refreshNativeEvidence(): Promise<NativeEvidence[]> {
  nativeEvidenceCache = (await Promise.all([...nativeRoots].map(async ([eventId, root]) => {
    const evidence = await (await mf.dispatchFetch('https://local/fixture/native-evidence?root=' + root)).json() as NativeEvidence[];
    return evidence.filter(value => value.eventId === 'T:' + eventId);
  }))).flat();
  return nativeEvidenceCache;
}

function nativeAdmissionCount(eventId: string): number {
  return nativeEvidenceCache.filter(value => value.eventId === 'T:' + eventId).length;
}

function providerRequestsFor(eventId: string): ProviderRequest[] {
  const marker = '[proof:' + eventId + ']';
  return providerRequests.filter(request => request.messages.some(message => {
    const content = message.content;
    const textParts = typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.flatMap(part => {
          if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? [text] : [];
        })
        : [];
    return textParts.some(text => text.includes(marker));
  }));
}

async function waitFor(description: string, predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await refreshNativeEvidence();
      if (await predicate()) return;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const evidence = { native: nativeEvidenceCache, slackPosts, providerCount: providerRequests.length };
  throw new Error('timeout waiting for ' + description + ': ' + JSON.stringify(evidence), { cause: lastError });
}

async function waitForSettlement(eventId: string): Promise<void> {
  await waitFor('settlement for ' + eventId, async () => {
    const current = await row(eventId);
    const delivery = await db.prepare(`SELECT t.status AS tracker_status,t.receipt_completed_at,
      COUNT(o.delivery_id) AS outbox_parts,SUM(CASE WHEN o.status='sent' THEN 1 ELSE 0 END) AS sent_parts
      FROM slack_ingress i JOIN slack_reply_trackers t ON t.instance_id=i.instance_id AND t.event_id=i.tracker_event_id
      LEFT JOIN slack_reply_outbox o ON o.instance_id=t.instance_id AND o.response_id=t.response_id
      WHERE i.event_id=?`).bind(eventId).first();
    return current?.state === 'accepted' && !!current.receipt_json
      && delivery?.tracker_status === 'delivered' && Number(delivery.receipt_completed_at) > 0
      && Number(delivery.outbox_parts) === 1 && Number(delivery.sent_parts) === 1
      && nativeAdmissionCount(eventId) === 1
      && nativeEvidenceCache.some(value => value.eventId === 'T:' + eventId && value.status === 'settled')
      && providerRequestsFor(eventId).length === 1;
  });
}

async function pumpFreshRecovery(eventId: string): Promise<void> {
  for (let invocation = 0; invocation < 8; invocation++) {
    await waitFor('unleased persisted recovery state for ' + eventId, async () => {
      const current = await row(eventId);
      return !current?.lease_owner || current.state === 'accepted';
    });
    const current = await row(eventId);
    if (current.state === 'accepted') break;
    assert.ok(['received', 'preparing', 'ready', 'uncertain'].includes(current.state),
      'unexpected retained state for ' + eventId + ': ' + String(current.state));
    if (current.next_attempt_at > Date.now()) {
      await db.prepare('UPDATE slack_ingress SET next_attempt_at=? WHERE event_id=?')
        .bind(Date.now(), eventId).run();
    }
    const response = await internalReconcile();
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json() as { processed: number; remaining: number };
    assert.equal(result.processed, 1, 'fresh recovery must claim the persisted row for ' + eventId);
  }
  await waitForSettlement(eventId);
}

async function producerCount(eventId?: string): Promise<number> {
  const current = eventId ? await row(eventId) : undefined;
  const result = current
    ? await db.prepare('SELECT COUNT(*) AS n FROM cutover_producers WHERE id=?').bind(current.id).first<{ n: number }>()
    : await db.prepare('SELECT COUNT(*) AS n FROM cutover_producers').first<{ n: number }>();
  return Number(result?.n ?? NaN);
}

async function setPersonality(value: string): Promise<void> {
  await db.prepare("UPDATE skills SET body_md=? WHERE project_id='P' AND name='personality'").bind(value).run();
}

function systemText(request: ProviderRequest): string {
  return request.messages.filter(message => message.role === 'system')
    .map(message => JSON.stringify(message.content)).join('\n');
}

try {
  await migrate();
  await db.prepare("UPDATE cutover_control SET state='open'").run();
  await db.prepare("INSERT INTO bindings(project_id,provider,external_account_id,external_space_id,transport_bot_id,transport_token_ref,status,created_at,updated_at) VALUES('P','slack','T','C','BOT','TEST_SLACK_TOKEN','active',0,0)").run();
  await db.prepare("INSERT INTO skills(project_id,name,description,body_md,state,updated_at) VALUES('P','personality','fixture personality','original-personality','active',0)").run();

  const publicMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
  const publicPaths = ['/agents/project/arbitrary', '/agent/project/arbitrary', '/project/arbitrary/dispatch', '/registry/arbitrary'];
  for (const method of publicMethods) for (const path of publicPaths) {
    const response = await mf.dispatchFetch('https://local/public' + path, { method });
    assert.ok(response.status >= 400 && response.status < 500, method + ' ' + path + ' must be denied');
    assert.equal(response.headers.get('x-local-namespace-accesses'), '0', method + ' ' + path + ' namespace access');
  }
  console.log('Public native surfaces denied before ingress work with zero namespace accesses.');

  let interruption = await interruptAt('ready-before-native');
  assert.equal((await signedSlackPost('ready-loss', '<@BOT> freeze original context', '1.0')).status, 200);
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM slack_ingress WHERE event_id=?').bind('ready-loss').first<{ n: number }>())?.n), 1);
  await interruption.reached;
  await setPersonality('changed-personality');
  await reconstruct();
  assert.equal((await row('ready-loss')).state, 'ready');
  assert.equal(await producerCount('ready-loss'), 1);
  await refreshNativeEvidence();
  assert.equal(nativeAdmissionCount('ready-loss'), 0);
  assert.equal(providerRequestsFor('ready-loss').length, 0);
  assert.equal((await signedSlackPost('ready-loss', '<@BOT> changed redelivery', '1.0')).status, 409);
  assert.equal((await signedSlackPost('ready-loss', '<@BOT> freeze original context', '1.0')).status, 200);
  await pumpFreshRecovery('ready-loss');
  assert.equal(await producerCount('ready-loss'), 0);
  const replayRequest = providerRequestsFor('ready-loss').at(-1)!;
  assert.ok(systemText(replayRequest).includes('original-personality'));
  assert.ok(!systemText(replayRequest).includes('changed-personality'));
  console.log('Ready-publication crash recovered through exact keyed replay using old frozen context.');

  assert.equal((await signedSlackPost('fresh-context', '<@BOT> load fresh context', '2.0')).status, 200);
  await pumpFreshRecovery('fresh-context');
  const freshRequest = providerRequestsFor('fresh-context').at(-1)!;
  assert.ok(systemText(freshRequest).includes('changed-personality'));
  assert.equal(await producerCount('fresh-context'), 0);
  console.log('Fresh event loaded changed context and released its canonical producer.');

  interruption = await interruptAt('native-accept-before-receipt');
  assert.equal((await signedSlackPost('receipt-loss', '<@BOT> survive native response loss', '3.0')).status, 200);
  // The webhook can publish without reserving enough queries for native contact.
  // Drive a fresh product recovery invocation while the native loss barrier is armed.
  await waitFor('ready handoff for receipt loss', async () => {
    const current = await row('receipt-loss');
    return current?.state === 'ready' && current.lease_owner === null;
  });
  const lossResponse = await internalReconcile();
  assert.equal(lossResponse.status, 200, await lossResponse.clone().text());
  await interruption.reached;
  await refreshNativeEvidence();
  assert.equal(nativeAdmissionCount('receipt-loss'), 1);
  await waitFor('native receipt-loss uncertainty', async () => {
    const current = await row('receipt-loss');
    return current?.state === 'uncertain' && current.receipt_json === null && current.lease_owner === null;
  });
  assert.equal((await row('receipt-loss')).receipt_json, null);
  assert.equal(await producerCount('receipt-loss'), 1);
  await reconstruct();
  await pumpFreshRecovery('receipt-loss');
  assert.equal(nativeAdmissionCount('receipt-loss'), 1);
  assert.equal(providerRequestsFor('receipt-loss').length, 1);
  assert.equal(await producerCount('receipt-loss'), 0);
  const receipt = JSON.parse((await row('receipt-loss')).receipt_json) as { submissionId: string; uid: string; acceptedAt: string };
  const native = nativeEvidenceCache.find(value => value.eventId === 'T:receipt-loss')!;
  assert.equal(receipt.submissionId, native.submissionId);
  console.log('Native acceptance survived receipt-response loss and reconstructed to one submission, answer, and release.');

  interruption = await interruptAt('acknowledged-before-recovery');
  const beforeAckEvent = slackPosts.filter(post => post.deliveryId.startsWith('ingress-ack:')).length;
  assert.equal((await signedSlackPost('ack-committed', '<@BOT> keep acknowledgement', '4.0')).status, 200);
  await interruption.reached;
  await waitFor('committed acknowledgement quiescence', async () => {
    const current = await row('ack-committed');
    return current?.ack_state === 'posted' && current.lease_owner === null;
  });
  await reconstruct();
  assert.equal((await row('ack-committed')).ack_state, 'posted');
  await pumpFreshRecovery('ack-committed');
  const afterAckEvent = slackPosts.filter(post => post.deliveryId.startsWith('ingress-ack:')).length;
  assert.equal(afterAckEvent, beforeAckEvent + 1);
  console.log('Committed acknowledgement survived crash recovery without a duplicate Slack post.');

  interruption = await interruptAt('prepare-lease-competition');
  assert.equal((await signedSlackPost('lease-race', '<@BOT> compete for publication', '5.0')).status, 200);
  await interruption.reached;
  const second = await internalReconcile();
  assert.deepEqual(await second.json(), { processed: 0, remaining: 1 });
  await interruption.release();
  await pumpFreshRecovery('lease-race');
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM slack_ingress_manifests m JOIN slack_ingress i ON i.id=m.ingress_id WHERE i.event_id=?').bind('lease-race').first<{ n: number }>())?.n), 1);
  assert.equal(nativeAdmissionCount('lease-race'), 1);
  assert.equal(providerRequestsFor('lease-race').length, 1);
  assert.equal(await producerCount('lease-race'), 0);
  console.log('Preparation/publication lease competition admitted exactly one native submission and answer.');

  loseNextAcknowledgement = true;
  assert.equal((await signedSlackPost('ack-response-loss', '<@BOT> recover acknowledgement', '6.0')).status, 200);
  await waitFor('acknowledgement uncertainty', async () => (await row('ack-response-loss'))?.ack_state === 'uncertain');
  const lossRow = await row('ack-response-loss');
  const lossDeliveryId = 'ingress-ack:' + String(lossRow.id);
  assert.equal(slackPosts.filter(post => post.deliveryId === lossDeliveryId).length, 1);
  await db.prepare('UPDATE slack_ingress SET next_attempt_at=0 WHERE event_id=?').bind('ack-response-loss').run();
  await pumpFreshRecovery('ack-response-loss');
  assert.equal(slackPosts.filter(post => post.deliveryId === lossDeliveryId).length, 1);
  assert.equal((await row('ack-response-loss')).ack_state, 'posted');
  console.log('Lost acknowledgement response repaired once from positive delivery metadata.');

  await refreshNativeEvidence();
  const expectedEventIds = ['ready-loss', 'fresh-context', 'receipt-loss', 'ack-committed', 'lease-race', 'ack-response-loss'];
  assert.deepEqual(nativeEvidenceCache.map(value => value.eventId).sort(), expectedEventIds.map(eventId => 'T:' + eventId).sort());
  for (const eventId of expectedEventIds) {
    assert.equal(nativeAdmissionCount(eventId), 1, 'one native admission for ' + eventId);
    assert.equal(providerRequestsFor(eventId).length, 1, 'one provider answer for ' + eventId);
    assert.equal(await producerCount(eventId), 0, 'producer released for ' + eventId);
    assert.ok(providerRequestsFor(eventId)[0]!.tools.some(tool => tool.function.name === 'update_status'));
    assert.ok(!providerRequestsFor(eventId)[0]!.tools.some(tool => tool.function.name === 'reply_to_conversation'));
  }
  assert.equal(await producerCount(), 0);
  assert.ok(providerRequests.every(request => !JSON.stringify(request).includes('fake-resolved-slack')
    && !JSON.stringify(request).includes('fake-resolved-model')));
  console.log('All six actual native submissions settled once; all canonical producers released; credentials stayed local.');
  console.log('Local emitted crash/replay proof complete. Remote D1 capacity/latency remains separately gated and unclaimed.');
} finally {
  await mf.dispose();
  await rm(temporary, { recursive: true, force: true });
}
