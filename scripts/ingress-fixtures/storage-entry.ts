// Minimal local probe Worker for the D1 ingress storage proof.
// Bundled with the installed esbuild and run under Miniflare's real D1 binding.
// Storage proof only: no model calls, no Slack calls, no DO/KV/sandbox bindings.
import type { AgentDispatchRequest } from '@flue/runtime';
import { acceptSlackIngress, type IngressDb, type IngressLease } from '../../src/slack/ingress-store';
import { FrozenRequestInvalid, loadFrozenRequest, storeFrozenRequest } from '../../src/slack/frozen-request';
import {
  parseSlackEventEnvelope, slackUrlVerification, slackUserMessageEvent, verifiedIngressEvent,
} from '../../src/slack/events';
import { verifySlackSignature } from '../../src/slack/verify';
import {
  NEAR_LIMIT_ENVELOPE_BYTES, frozenRequestBytes, probeRouteFor, probeTextRequest, utf8PaddedRequest,
} from './storage-payload';

const SETUP_NOW = 10_000;
const LEASE_MS = 600_000;

interface QueryMeter { count: number; queries: string[] }

/** Statement-counting adapter over the real D1 binding; every bound statement still executes. */
function meteredDb(db: D1Database, meter: QueryMeter): IngressDb {
  const bound = new WeakMap<object, { statement: D1PreparedStatement; query: string }>();
  return {
    prepare: query => ({ bind: (...values: unknown[]) => {
      const statement = db.prepare(query).bind(...values);
      const wrapped = {
        run: async () => { meter.count++; meter.queries.push(query); return statement.run(); },
        first: async <T>() => { meter.count++; meter.queries.push(query); return statement.first<T>(); },
        all: async <T>() => { meter.count++; meter.queries.push(query); return statement.all<T>(); },
      };
      bound.set(wrapped, { statement, query });
      return wrapped;
    } }),
    batch: async statements => {
      const underlying = statements.map(statement => bound.get(statement)?.statement ?? statement) as D1PreparedStatement[];
      const result = await db.batch(underlying);
      for (const statement of statements) {
        const entry = bound.get(statement);
        if (entry) { meter.count++; meter.queries.push(entry.query); }
      }
      return result;
    },
  };
}

async function setupPreparingRow(db: D1Database, eventId: string): Promise<{ ingressId: string; lease: IngressLease; queries: number }> {
  const ingressId = `storage-proof:${eventId}`;
  const eventJson = JSON.stringify({ type: 'event_callback', team_id: 'T', event_id: eventId,
    event: { type: 'message', channel: 'C', ts: '1.0', user: 'U', text: 'storage probe' } });
  await db.prepare(
    'INSERT INTO slack_ingress(id,team_id,event_id,digest,event_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)'
  ).bind(ingressId, 'T', eventId, 'f'.repeat(64), eventJson, SETUP_NOW, SETUP_NOW).run();
  const lease: IngressLease = { id: ingressId, owner: 'local-storage-proof', revision: 1, expiresAt: SETUP_NOW + LEASE_MS, phase: 'prepare' };
  await db.prepare(
    "UPDATE slack_ingress SET state='preparing',lease_owner=?,revision=?,lease_expires_at=?,prepare_attempts=1 WHERE id=?"
  ).bind(lease.owner, lease.revision, lease.expiresAt, ingressId).run();
  const route = probeRouteFor(eventId);
  await db.prepare(
    "UPDATE slack_ingress SET target_json=?,mode='overhear',instance_id=?,tracker_event_id=?,effects_complete=1,ack_state='skipped' WHERE id=?"
  ).bind(JSON.stringify(route), route.instanceId, route.deliveryEventId, ingressId).run();
  return { ingressId, lease, queries: 3 };
}

async function hexDigest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)),
    byte => byte.toString(16).padStart(2, '0')).join('');
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function buildRequest(body: { eventId: string; utf8: boolean; targetBytes?: number }): AgentDispatchRequest {
  return body.utf8 ? utf8PaddedRequest(body.targetBytes ?? NEAR_LIMIT_ENVELOPE_BYTES) : probeTextRequest(body.eventId);
}

async function handleStore(db: D1Database, input: { eventId: string; utf8: boolean; targetBytes?: number }): Promise<Response> {
  const { ingressId, lease, queries: setupQueries } = await setupPreparingRow(db, input.eventId);
  const request = buildRequest(input);
  const meter: QueryMeter = { count: 0, queries: [] };
  const start = performance.now();
  let stored = false;
  let errorName: string | null = null;
  try { stored = await storeFrozenRequest(meteredDb(db, meter), lease, request, SETUP_NOW); }
  catch (error) { errorName = (error as Error).name; }
  const durationMs = performance.now() - start;
  const manifest = await db.prepare(
    'SELECT id,total_bytes,chunk_count,digest,created_at FROM slack_ingress_manifests WHERE ingress_id=?'
  ).bind(ingressId).first<{ id: string; total_bytes: number; chunk_count: number; digest: string; created_at: number }>();
  const chunks = manifest
    ? await db.prepare(
      'SELECT COUNT(*) AS count,MIN(ordinal) AS first_ordinal,MAX(ordinal) AS last_ordinal,'
      + 'MIN(length(bytes)) AS min_bytes,MAX(length(bytes)) AS max_bytes,SUM(length(bytes)) AS sum_bytes '
      + 'FROM slack_ingress_chunks WHERE manifest_id=?'
    ).bind(manifest.id).first<{ count: number; first_ordinal: number; last_ordinal: number; min_bytes: number; max_bytes: number; sum_bytes: number }>()
    : null;
  const row = await db.prepare('SELECT state,manifest_id,revision,lease_owner FROM slack_ingress WHERE id=?')
    .bind(ingressId).first<{ state: string; manifest_id: string | null; revision: number; lease_owner: string | null }>();
  const producer = await db.prepare('SELECT COUNT(*) AS n FROM cutover_producers WHERE id=?')
    .bind(ingressId).first<{ n: number }>();
  return json({
    stored, ingressId, manifestId: manifest?.id ?? null, manifest, chunks, row,
    producerRetained: Number(producer?.n ?? 0), durationMs, queries: meter.count,
    queryList: meter.queries, setupQueries, errorName,
  });
}

async function handleLoad(db: D1Database, input: { ingressId: string; eventId: string; utf8: boolean; targetBytes?: number }): Promise<Response> {
  const meter: QueryMeter = { count: 0, queries: [] };
  const start = performance.now();
  let loaded: AgentDispatchRequest | null = null;
  let errorName: string | null = null;
  let errorMessage: string | null = null;
  try { loaded = await loadFrozenRequest(meteredDb(db, meter), input.ingressId); }
  catch (error) {
    errorName = error instanceof FrozenRequestInvalid ? 'FrozenRequestInvalid' : (error as Error).name;
    errorMessage = (error as Error).message;
  }
  const durationMs = performance.now() - start;
  let digest: string | null = null;
  let byteCount: number | null = null;
  let replayIdentical: boolean | null = null;
  if (loaded) {
    const bytes = frozenRequestBytes(loaded);
    byteCount = bytes.length;
    digest = await hexDigest(bytes);
    replayIdentical = JSON.stringify(loaded) === JSON.stringify(buildRequest(input));
  }
  return json({ ok: loaded !== null, digest, byteCount, replayIdentical, durationMs,
    queries: meter.count, queryList: meter.queries, errorName, errorMessage });
}

async function handleAccept(request: Request, env: Record<string, unknown>, db: D1Database): Promise<Response> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 1_000_000) return json({ error: 'Slack acceptance body too large' }, 413);
  const verified = await verifySlackSignature(String(env.SLACK_SIGNING_SECRET ?? ''), raw,
    request.headers.get('x-slack-request-timestamp'), request.headers.get('x-slack-signature'));
  if (!verified) return json({ error: 'unauthorized' }, 401);
  let body: ReturnType<typeof parseSlackEventEnvelope>;
  try { body = parseSlackEventEnvelope(raw); } catch { return json({ error: 'invalid Slack event' }, 400); }
  const verification = slackUrlVerification(body);
  if (verification) return json({ challenge: verification.challenge });
  const ev = slackUserMessageEvent(body);
  if (!ev) return json({ error: 'non-user event' }, 400);
  if (env.CUTOVER_CONTROL !== 'd1') return json({ error: 'durable control unavailable' }, 503);
  const event = await verifiedIngressEvent(raw, body, ev);
  const meter: QueryMeter = { count: 0, queries: [] };
  const start = performance.now();
  const accepted = await acceptSlackIngress(meteredDb(db, meter), event);
  return json({
    status: accepted.status, id: 'id' in accepted ? accepted.id : null,
    duplicate: 'duplicate' in accepted ? accepted.duplicate : null,
    providerDigest: event.digest, providerByteCount: new TextEncoder().encode(raw).length,
    durationMs: performance.now() - start, queries: meter.count, queryList: meter.queries,
  });
}

type FaultMode = 'missing-chunk' | 'corrupt-chunk' | 'corrupt-manifest-digest';

async function handleFault(db: D1Database, ingressId: string, mode: FaultMode): Promise<Response> {
  const row = await db.prepare('SELECT manifest_id FROM slack_ingress WHERE id=?')
    .bind(ingressId).first<{ manifest_id: string | null }>();
  if (!row?.manifest_id) return json({ error: 'no published frozen request' }, 400);
  const manifestId = row.manifest_id;
  const guard = mode === 'missing-chunk' ? 'slack_ingress_chunk_delete_guard'
    : mode === 'corrupt-chunk' ? 'slack_ingress_chunk_immutable' : 'slack_ingress_manifest_immutable';
  await db.prepare('DROP TRIGGER IF EXISTS ' + guard).bind().run();
  if (mode === 'missing-chunk') {
    await db.prepare('DELETE FROM slack_ingress_chunks WHERE manifest_id=? AND ordinal=0').bind(manifestId).run();
  } else if (mode === 'corrupt-chunk') {
    const chunk = await db.prepare('SELECT bytes FROM slack_ingress_chunks WHERE manifest_id=? AND ordinal=0')
      .bind(manifestId).first<{ bytes: number[] }>();
    if (!chunk) return json({ error: 'missing chunk' }, 400);
    const bytes = Uint8Array.from(chunk.bytes);
    // Set the first byte to a deterministic value different from the canonical
    // JSON opening brace. Repeating a resumed trial must not heal its corruption.
    bytes[0] = 0;
    await db.prepare('UPDATE slack_ingress_chunks SET bytes=? WHERE manifest_id=? AND ordinal=0').bind(bytes, manifestId).run();
  } else {
    const manifest = await db.prepare('SELECT digest FROM slack_ingress_manifests WHERE id=?')
      .bind(manifestId).first<{ digest: string }>();
    if (!manifest) return json({ error: 'missing manifest' }, 400);
    await db.prepare('UPDATE slack_ingress_manifests SET digest=? WHERE id=?').bind('0'.repeat(64), manifestId).run();
  }
  let failedClosed = false;
  let errorName: string | null = null;
  let errorMessage: string | null = null;
  try { await loadFrozenRequest(db, ingressId); }
  catch (error) {
    failedClosed = error instanceof FrozenRequestInvalid;
    errorName = error instanceof FrozenRequestInvalid ? 'FrozenRequestInvalid' : (error as Error).name;
    errorMessage = (error as Error).message;
  }
  const retained = await db.prepare(
    'SELECT (SELECT COUNT(*) FROM slack_ingress_chunks WHERE manifest_id=?) AS chunk_rows,'
    + ' (SELECT COUNT(*) FROM slack_ingress_manifests WHERE id=?) AS manifest_rows,'
    + " (SELECT state FROM slack_ingress WHERE id=?) AS state,"
    + ' (SELECT manifest_id FROM slack_ingress WHERE id=?) AS manifest_id,'
    + ' (SELECT COUNT(*) FROM cutover_producers WHERE id=?) AS producer_rows'
  ).bind(manifestId, manifestId, ingressId, ingressId, ingressId)
    .first<{ chunk_rows: number; manifest_rows: number; state: string; manifest_id: string | null; producer_rows: number }>();
  return json({ mode, failedClosed, errorName, errorMessage, retained, droppedTrigger: guard });
}

export default {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    const url = new URL(request.url);
    const db = env.DB as D1Database;
    try {
      if (url.pathname === '/probe/health' && request.method === 'GET') {
        return json({ ok: true, worker: 'morehands-d1-storage-proof', memoryPlatformAvailable: false });
      }
      if (url.pathname === '/probe/accept' && request.method === 'POST') {
        return await handleAccept(request, env, db);
      }
      if (url.pathname === '/probe/control' && request.method === 'POST') {
        const body = await request.json() as { state?: unknown };
        if (body.state !== 'open' && body.state !== 'closed') return json({ error: 'invalid state' }, 400);
        await db.prepare('UPDATE cutover_control SET state=?,revision=revision+1 WHERE id=1').bind(body.state).run();
        return json({ state: body.state });
      }
      if (url.pathname === '/probe/store' && request.method === 'POST') {
        const body = await request.json() as { eventId?: unknown; utf8?: unknown; targetBytes?: unknown };
        if (typeof body.eventId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(body.eventId) || body.eventId.length > 64
          || typeof body.utf8 !== 'boolean'
          || (body.targetBytes !== undefined && (!Number.isSafeInteger(body.targetBytes) || (body.targetBytes as number) <= 0))) {
          return json({ error: 'invalid store request' }, 400);
        }
        return await handleStore(db, { eventId: body.eventId, utf8: body.utf8, targetBytes: body.targetBytes as number | undefined });
      }
      if (url.pathname === '/probe/load' && request.method === 'POST') {
        const body = await request.json() as { ingressId?: unknown; eventId?: unknown; utf8?: unknown; targetBytes?: unknown };
        if (typeof body.ingressId !== 'string' || !body.ingressId.startsWith('storage-proof:')
          || typeof body.eventId !== 'string' || typeof body.utf8 !== 'boolean'
          || (body.targetBytes !== undefined && (!Number.isSafeInteger(body.targetBytes) || (body.targetBytes as number) <= 0))) {
          return json({ error: 'invalid load request' }, 400);
        }
        return await handleLoad(db, { ingressId: body.ingressId, eventId: body.eventId, utf8: body.utf8, targetBytes: body.targetBytes as number | undefined });
      }
      if (url.pathname === '/probe/fault' && request.method === 'POST') {
        const body = await request.json() as { ingressId?: unknown; mode?: unknown };
        if (typeof body.ingressId !== 'string' || !body.ingressId.startsWith('storage-proof:')
          || (body.mode !== 'missing-chunk' && body.mode !== 'corrupt-chunk' && body.mode !== 'corrupt-manifest-digest')) {
          return json({ error: 'invalid fault request' }, 400);
        }
        return await handleFault(db, body.ingressId, body.mode);
      }
      return json({ error: 'not found' }, 404);
    } catch (error) {
      return json({ error: (error as Error).name, message: (error as Error).message }, 500);
    }
  },
};
