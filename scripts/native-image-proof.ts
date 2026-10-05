import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { PNG_BASE64, providerResponse } from './image-fixtures/provider-response';
import { migrationStatements } from './migration-statements';

const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { build } = require('esbuild');
const configPath = resolve('dist/hatchery/wrangler.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const artifactRoot = dirname(configPath);
const temporary = await mkdtemp(join(tmpdir(), 'morehands-native-image-'));
const scriptPath = join(temporary, 'entry.mjs');
const requests: any[] = [];
let slackPosts = 0;
let imageBytes = Buffer.from(PNG_BASE64, 'base64');
let twoImages = false;
let holdNextProvider: Promise<void> | undefined;
await build({ entryPoints: [resolve('scripts/image-fixtures/native-entry.ts')], outfile: scriptPath,
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  plugins: [{ name: 'native-artifact', setup(builder: any) {
    builder.onResolve({ filter: /^image-native-artifact$/ }, () => ({ path: `./${config.main}`, external: true }));
  } }],
});
const modules: Record<string, { type: 'esm'; contents: string }> = {
  'image-proof.mjs': { type: 'esm', contents: await readFile(scriptPath, 'utf8') },
};
for (const file of await readdir(artifactRoot, { recursive: true })) {
  if (file.endsWith('.js')) modules[file] = { type: 'esm', contents: await readFile(join(artifactRoot, file), 'utf8') };
}
const options = convertV4MiniflareOptions({ name: 'local-image-proof', modules: true, scriptPath,
  compatibilityDate: config.compatibility_date, compatibilityFlags: ['nodejs_compat'],
  durableObjects: { FLUE_PROJECT_AGENT: { className: 'LocalImageAgent', useSQLite: true },
    FLUE_REGISTRY: { className: 'FlueRegistry', useSQLite: true } },
  d1Databases: ['DB'], kvNamespaces: ['SLACK_EVENTS'], resourcePersistencePath: join(temporary, 'sqlite'),
  bindings: { CUTOVER_CONTROL: 'd1', SLACK_SIGNING_SECRET: 'local-signing', KNOWN_TEAM_IDS: 'T',
    SLACK_BOT_ID: 'BOT', TEST_SLACK_TOKEN: 'fake-resolved-slack', ZAI_API_KEY: 'fake-resolved-model',
    HEARTBEAT_TOKEN: 'fake-local-heartbeat' },
  telemetry: { enabled: false },
  outboundService: async (request: Request) => {
    const url = new URL(request.url);
    if (url.href === 'https://api.z.ai/api/coding/paas/v4/chat/completions') {
      const body = await request.json() as any;
      assert.equal(body.model, 'glm-5.3-flash'); assert.equal(body.stream, true);
      requests.push(body);
      const hold = holdNextProvider; holdNextProvider = undefined;
      if (hold) await hold;
      return providerResponse();
    }
    if (url.origin === 'https://slack.com' && url.pathname === '/api/files.info') {
      const id = url.searchParams.get('file'); assert.ok(id === 'F' || id === 'G');
      return Response.json({ ok: true, file: { id, size: imageBytes.length, mimetype: 'image/png',
        url_private_download: `https://files.slack.com/private/${id}` } });
    }
    if (url.href === 'https://files.slack.com/private/F' || url.href === 'https://files.slack.com/private/G') {
      return new Response(imageBytes, { headers: { 'content-type': 'image/png' } });
    }
    if (url.origin === 'https://slack.com') {
      switch (url.pathname) {
        case '/api/conversations.replies': case '/api/conversations.history':
          return Response.json({ ok: true, messages: [], has_more: false });
        case '/api/users.info': return Response.json({ ok: true, user: { id: 'U', name: 'fixture-user', profile: { display_name: 'Fixture User' } } });
        case '/api/chat.postMessage': return Response.json({ ok: true, ts: `${++slackPosts + 10}.0`, channel: 'C' });
        case '/api/chat.update': case '/api/reactions.add': case '/api/reactions.remove': return Response.json({ ok: true });
      }
    }
    throw new Error(`unscripted local outbound request: ${url.origin}${url.pathname}`);
  },
});
options.workers[0].config.manifest = { mainModule: 'image-proof.mjs', modulesRoot: artifactRoot, modules };
let mf = new Miniflare(options);
try {
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir(resolve('migrations'))).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await readFile(resolve('migrations', file), 'utf8');
    const statements = migrationStatements(sql);
    await db.batch(statements.map(s => db.prepare(s)));
  }
  await db.prepare("UPDATE cutover_control SET state='open'").run();
  await db.prepare(`INSERT INTO bindings(project_id,provider,external_account_id,external_space_id,transport_bot_id,
    transport_token_ref,status,created_at,updated_at) VALUES('P','slack','T','C','BOT','TEST_SLACK_TOKEN','active',0,0)`).run();
  await db.prepare(`INSERT INTO skills(project_id,name,description,body_md,state,updated_at)
    VALUES('P','personality','fixture personality','creation-personality','active',0)`).run();
  for (const method of ['GET', 'HEAD', 'POST', 'DELETE']) {
    const response = await mf.dispatchFetch('https://local/public/agents/project/arbitrary', { method });
    assert.equal(response.status, 404); assert.equal(response.headers.get('x-local-namespace-accesses'), '0');
  }
  console.log('Public Project route denied without namespace access.');
  const durableAcceptance = async (eventId: string) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const row = await (await mf.getD1Database('DB') as D1Database).prepare(
        'SELECT COUNT(*) AS n FROM slack_ingress WHERE event_id=?'
      ).bind(eventId).first<{ n: number }>();
      if (row?.n === 1) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('durable Slack acceptance timeout for ' + eventId);
  };
  const ingressRow = async (eventId: string) => (await (await mf.getD1Database('DB') as D1Database)
    .prepare('SELECT state,receipt_json,lease_owner,next_attempt_at FROM slack_ingress WHERE event_id=?')
    .bind(eventId).first<any>());
  const internalReconcile = () => mf.dispatchFetch('https://local/__internal/slack-ingress/reconcile', {
    method: 'POST', body: '{}',
    headers: { 'x-morehands-token': 'fake-local-heartbeat', 'content-type': 'application/json' },
  });
  const recoverAccepted = async (eventId: string, stopAfterOneHandoff = false) => {
    for (let invocation = 0; invocation < 8; invocation++) {
      const deadline = Date.now() + 10_000;
      let row: any;
      while (Date.now() < deadline) {
        row = await ingressRow(eventId);
        if (!row?.lease_owner || row.state === 'accepted') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(row && (!row.lease_owner || row.state === 'accepted'), 'recovery lease did not clear for ' + eventId);
      if (row.state === 'accepted') {
        assert.ok(row.receipt_json, 'accepted ingress row has no native receipt for ' + eventId);
        return;
      }
      assert.ok(['received','preparing','ready','uncertain'].includes(row.state), 'unexpected retained ingress state for ' + eventId + ': ' + String(row.state));
      if (row.next_attempt_at > Date.now()) {
        await (await mf.getD1Database('DB') as D1Database).prepare(
          'UPDATE slack_ingress SET next_attempt_at=? WHERE event_id=?'
        ).bind(Date.now(), eventId).run();
      }
      const response = await internalReconcile();
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json() as { processed: number; remaining: number };
      assert.ok(result.processed === 0 || result.processed === 1, 'unexpected recovery result for ' + eventId);
      if (stopAfterOneHandoff) return;
    }
    throw new Error('accepted ingress recovery timeout for ' + eventId);
  };
  const productDelivered = async (eventId: string) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const row = await (await mf.getD1Database('DB') as D1Database).prepare(`SELECT i.state,t.status,t.receipt_completed_at,
        COUNT(o.delivery_id) AS parts,SUM(CASE WHEN o.status='sent' THEN 1 ELSE 0 END) AS sent
        FROM slack_ingress i JOIN slack_reply_trackers t ON t.instance_id=i.instance_id AND t.event_id=i.tracker_event_id
        LEFT JOIN slack_reply_outbox o ON o.instance_id=t.instance_id AND o.response_id=t.response_id
        WHERE i.event_id=?`).bind(eventId).first<any>();
      if (row?.state === 'accepted' && row.status === 'delivered' && Number(row.receipt_completed_at) > 0
        && Number(row.parts) > 0 && Number(row.parts) === Number(row.sent)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('delivered product reply timeout for ' + eventId);
  };
  const send = async (eventId: string, ts: string, image = false) => {
    const raw = JSON.stringify({ type: 'event_callback', team_id: 'T', event_id: eventId,
      event: { type: 'message', channel: 'C', user: 'U', ts, thread_ts: '1.0', text: '<@BOT> describe',
        ...(image ? { subtype: 'file_share', files: (twoImages ? ['F', 'G'] : ['F']).map(id => ({ id, name: 'red.png', mimetype: 'image/png', size: 69 })) } : {}) } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', 'local-signing').update(`v0:${timestamp}:${raw}`).digest('hex');
    const response = await mf.dispatchFetch('https://local/slack/events', { method: 'POST', body: raw,
      headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${signature}` } });
    assert.equal(response.status, 200, await response.clone().text());
    await durableAcceptance(eventId);
  };
  const settled = async (count: number) => {
    const deadline = Date.now() + 20_000;
    let observation: any;
    while (Date.now() < deadline) {
      observation = await (await mf.dispatchFetch('https://local/fixture/observe')).json();
      if (requests.length >= count && observation.nativeStatuses?.settled >= count) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`native settlement timeout: requests=${requests.length}, ${JSON.stringify(observation)}`);
  };
  const settledAndRecovered = async (eventId: string, count: number) => {
    await recoverAccepted(eventId);
    await settled(count);
    await productDelivered(eventId);
  };
  await send('create', '1.0'); await recoverAccepted('create'); await settled(1);
  await db.prepare("UPDATE skills SET body_md='fresh-personality' WHERE project_id='P' AND name='personality'").run();
  await send('image', '2.0', true); await recoverAccepted('image', true); await settled(2);
  assert.equal((await ingressRow('image'))?.state, 'uncertain', 'first image handoff must retain receipt loss');
  const beforeRecovery = await db.prepare("SELECT submission_id FROM slack_reply_trackers WHERE event_id='T:image'").first();
  assert.equal(beforeRecovery?.submission_id, null, 'fixture must lose the accepted image receipt');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM slack_reply_outbox').first())?.n, 0);
  const postsBeforeRecovery = slackPosts;
  await mf.dispose();
  mf = new Miniflare(options);
  const recoveredDb = await mf.getD1Database('DB');
  await recoverAccepted('image');
  await mf.dispatchFetch('https://local/fixture/reconcile');
  const recovered = await recoveredDb.prepare("SELECT submission_id FROM slack_reply_trackers WHERE event_id='T:image'").first();
  assert.ok(recovered?.submission_id, 'actual native admission must heal the missing image receipt after reconstruction');
  const recoveredReplies = await recoveredDb.prepare(`SELECT text FROM slack_reply_outbox WHERE response_id=(
    SELECT response_id FROM slack_reply_trackers WHERE event_id='T:image')`).all();
  assert.equal(recoveredReplies.results.length, 1);
  assert.equal(recoveredReplies.results[0].text, 'local image answer');
  await productDelivered('image');
  const postsAfterFirstRecovery = slackPosts;
  await mf.dispatchFetch('https://local/fixture/reconcile');
  assert.equal((await recoveredDb.prepare(`SELECT COUNT(*) AS n FROM slack_reply_outbox WHERE response_id=(
    SELECT response_id FROM slack_reply_trackers WHERE event_id='T:image')`).first())?.n, 1);
  assert.equal(slackPosts, postsAfterFirstRecovery, 'second reconciliation must not post another Slack answer');
  console.log('Actual image receipt loss healed after native reconstruction, with one delivered and idempotent outbox reply.');
  const body = requests.at(-1);
  const images = body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'image_url') : []);
  if (!images.length) {
    const evidence = await (await mf.dispatchFetch('https://local/fixture/evidence')).json();
    console.log('Missing image admission diagnostics:', JSON.stringify(evidence));
  }
  assert.equal(images.length, 1); assert.equal(images[0].image_url.url, `data:image/png;base64,${PNG_BASE64}`);
  console.log('Actual emitted Project produced one native PNG image block; zero live network/model calls.');
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('fake-resolved-slack')); assert.ok(!serialized.includes('fake-resolved-model'));
  const system = body.messages.filter((m: any) => m.role === 'system').map((m: any) => JSON.stringify(m.content)).join('\n');
  assert.ok(system.includes('fresh-personality'), 'image turn must use fresh personality');
  assert.ok(!system.includes('creation-personality'), 'image system must not use creation personality');
  const tools = body.tools.map((t: any) => t.function.name);
  assert.ok(tools.includes('update_status'), 'engaged image must expose update_status');
  assert.ok(!tools.includes('reply_to_conversation'), 'engaged image must not expose autonomous publication');
  console.log('Native image current context and engaged tool exposure verified.');
  const evidence = await (await mf.dispatchFetch('https://local/fixture/evidence')).json() as any[];
  assert.equal(evidence.at(-1).eventId, 'T:image');
  assert.equal(evidence.at(-1).transportTokenRef, 'TEST_SLACK_TOKEN');
  console.log('Model-visible envelope snapshot fields:', evidence.at(-1).snapshotFields.join(', '));
  console.log('Token-reference name is model-visible; resolved credential values are absent.');
  // Size characterization only: PNG plus trailing zero padding is not a decoding proof.
  // The valid tiny PNG above independently proves the native image path.
  imageBytes = Buffer.alloc(4_000_000); Buffer.from(PNG_BASE64, 'base64').copy(imageBytes);
  await send('size-boundary', '3.0', true); await settledAndRecovered('size-boundary', 3);
  const largeEvidence = await (await mf.dispatchFetch('https://local/fixture/evidence')).json() as any[];
  console.log('Persisted admission size evidence:', JSON.stringify(largeEvidence.at(-1)));
  const largeImages = requests.at(-1).messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'image_url') : []);
  assert.ok(largeImages.some((p: any) => p.image_url.url.length > 5_333_333), 'large bytes must reach the native provider block');
  console.log('Accepted single 4,000,000-byte media payload through actual native projection.');
  twoImages = true;
  await send('two-image-boundary', '4.0', true); await settledAndRecovered('two-image-boundary', 4);
  const fullRequest = await (await mf.dispatchFetch('https://local/fixture/request-size')).json() as any;
  assert.ok(fullRequest.bytes > 10_666_666);
  assert.ok(fullRequest.bytes < 11_500_000, 'boundary sample retains encoded headroom');
  const twoLarge = requests.at(-1).messages.at(-1).content.filter((p: any) => p.type === 'image_url');
  assert.equal(twoLarge.length, 2);
  console.log('Two raw 4MB images admitted and projected; original native request size:', JSON.stringify(fullRequest));
  const contextLength = 'fresh-personality'.length + Math.floor((11_495_000 - fullRequest.bytes) / 2);
  await recoveredDb.prepare("UPDATE skills SET body_md=? WHERE project_id='P' AND name='personality'").bind('p'.repeat(contextLength)).run();
  await send('context-boundary', '5.0', true); await settledAndRecovered('context-boundary', 5);
  const contextRequest = await (await mf.dispatchFetch('https://local/fixture/request-size')).json() as any;
  assert.ok(contextRequest.bytes > 11_490_000 && contextRequest.bytes < 11_500_000);
  const latestUser = (eventId: string) => {
    const scopedEventId = 'T:' + eventId;
    return requests.slice().reverse().flatMap((request: any) => request.messages.slice().reverse()).find((message: any) =>
      message.role === 'user' && Array.isArray(message.content) && message.content.some((part: any) => part.type === 'text' && part.text.includes('"eventId":"' + scopedEventId + '"')));
  };
  const contextUser = latestUser('context-boundary');
  assert.ok(contextUser, 'boundary request must reach provider projection');
  assert.equal(contextUser.content.filter((p: any) => p.type === 'image_url').length, 2);
  console.log('Near-ceiling context plus two images accepted:', JSON.stringify(contextRequest));
  await recoveredDb.prepare("UPDATE skills SET body_md=? WHERE project_id='P' AND name='personality'").bind('p'.repeat(contextLength + 20_000)).run();
  await send('context-overflow', '6.0', true); await settledAndRecovered('context-overflow', 6);
  const overflowUser = latestUser('context-overflow');
  assert.ok(overflowUser, 'overflow request must reach provider projection');
  assert.equal(overflowUser.content.filter((p: any) => p.type === 'image_url').length, 1);
  const overflowText = overflowUser.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
  assert.ok(overflowText.includes('native-payload-limit'));
  const overflowRequest = await (await mf.dispatchFetch('https://local/fixture/request-size')).json() as any;
  assert.ok(overflowRequest.bytes < 11_500_000);
  console.log('Overflow dropped one lower-priority image and preserved safe omission:', JSON.stringify(overflowRequest));
  // Admit an image while the host text turn is blocked at its real provider boundary.
  imageBytes = Buffer.from(PNG_BASE64, 'base64'); twoImages = false;
  await recoveredDb.prepare("UPDATE skills SET body_md='busy-host-personality' WHERE project_id='P' AND name='personality'").run();
  let releaseProvider!: () => void;
  holdNextProvider = new Promise<void>(resolve => { releaseProvider = resolve; });
  const beforeBusyRequests = requests.length;
  await send('busy-host', '7.0');
  await recoverAccepted('busy-host');
  const busyDeadline = Date.now() + 20_000;
  while (requests.length === beforeBusyRequests && Date.now() < busyDeadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(requests.length > beforeBusyRequests, 'host provider must be held before joining');
  await recoveredDb.prepare("UPDATE skills SET body_md='busy-image-personality' WHERE project_id='P' AND name='personality'").run();
  await send('busy-image', '8.0', true);
  await recoverAccepted('busy-image');
  const joinedTracker = await recoveredDb.prepare("SELECT ack_message_ts FROM slack_reply_trackers WHERE event_id='T:busy-image'").first();
  assert.equal(joinedTracker?.ack_message_ts, null, 'joined image must not borrow a working receipt');
  releaseProvider();
  await settled(8);
  await productDelivered('busy-host'); await productDelivered('busy-image');
  const joinedRequests = requests.slice(beforeBusyRequests).filter((request: any) => request.messages.some((message: any) =>
    message.role === 'user' && Array.isArray(message.content) && message.content.some((part: any) => part.type === 'text' && part.text.includes('"eventId":"T:busy-image"'))));
  assert.ok(joinedRequests.length, 'joined image must reach provider');
  assert.ok(joinedRequests.some((request: any) => request.messages.some((message: any) => message.role === 'system' && JSON.stringify(message.content).includes('busy-image-personality'))));
  assert.ok(joinedRequests.every((request: any) => request.tools.some((tool: any) => tool.function.name === 'update_status')
    && !request.tools.some((tool: any) => tool.function.name === 'reply_to_conversation')));
  console.log('Actual busy image join used current personality and engaged tools without borrowing a receipt.');
  console.log('Application bound: 11,500,000 UTF-8 bytes with 4096 bytes reserved for native transport metadata.');
  console.log('This is pinned local acceptance/projection evidence, not a universal HTTP capacity or pixel-decoding claim.');
} finally { await mf.dispose(); await rm(temporary, { recursive: true, force: true }); }
