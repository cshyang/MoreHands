// Isolated remote D1 probe. No product Worker, native DO, model, Slack API or sandbox binding.
import localProbe from './storage-entry';
import { withIngressBudget, ingressBudget } from '../../src/slack/ingress-budget';
import type { D1Like } from '../../src/skills/repository';

export interface RemoteProbeEnv {
  DB: D1Database;
  PROBE_ID: string;
  PROBE_DATABASE_ID: string;
  PROBE_DATABASE_NAME: string;
  PROBE_TOKEN: string;
}
const PRODUCTION_DATABASE_ID = '6ac5de79-a8c0-4e08-aab8-b9b636278a9d';
const paths = new Set(['/probe/health', '/probe/control', '/probe/accept', '/probe/store', '/probe/load', '/probe/fault', '/probe/inspect', '/probe/cleanup']);

function validToken(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expected) || actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}
export function validateProbeIdentity(env: Pick<RemoteProbeEnv, 'PROBE_ID' | 'PROBE_DATABASE_ID' | 'PROBE_DATABASE_NAME'>): boolean {
  return /^[a-f0-9]{16}$/.test(env.PROBE_ID)
    && env.PROBE_DATABASE_NAME === `morehands-cutover-db-${env.PROBE_ID}`
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(env.PROBE_DATABASE_ID)
    && env.PROBE_DATABASE_ID !== PRODUCTION_DATABASE_ID;
}
function scopedEvent(id: unknown, probeId: string): id is string {
  return typeof id === 'string' && new RegExp(`^${probeId}-[A-Za-z0-9.-]{1,40}$`).test(id);
}

async function inspect(db: D1Database, eventId: string) {
  return db.prepare(
    'SELECT i.id,i.digest,i.state,i.manifest_id,'
    + '(SELECT COUNT(*) FROM slack_ingress WHERE team_id=i.team_id AND event_id=i.event_id) AS event_rows,'
    + '(SELECT COUNT(*) FROM cutover_producers WHERE id=i.id) AS producer_rows,'
    + '(SELECT COUNT(*) FROM slack_ingress_chunks WHERE manifest_id=i.manifest_id) AS chunk_rows,'
    + '(SELECT total_bytes FROM slack_ingress_manifests WHERE id=i.manifest_id) AS frozen_bytes,'
    + '(SELECT digest FROM slack_ingress_manifests WHERE id=i.manifest_id) AS frozen_digest '
    + 'FROM slack_ingress i WHERE i.event_id=? AND i.team_id=?'
  ).bind(eventId, 'T').first();
}

async function cleanup(db: D1Database, probeId: string): Promise<Response> {
  const foreign = await db.prepare('SELECT COUNT(*) AS n FROM slack_ingress WHERE event_id NOT LIKE ?')
    .bind(`${probeId}-%`).first<{ n: number }>();
  if (Number(foreign?.n) !== 0) return Response.json({ error: 'foreign rows present; cleanup retained' }, { status: 409 });
  const guards = (await db.prepare('SELECT name,sql FROM probe_guard_definitions ORDER BY name')
    .bind().all<{ name: string; sql: string }>()).results;
  if (!guards?.length || guards.some(g => !/^slack_ingress_[a-z_]+$/.test(g.name) || !g.sql)) {
    return Response.json({ error: 'unknown guards; cleanup retained' }, { status: 409 });
  }
  // This database is wholly probe-owned. Only its scoped rows are reclaimed. Restore all guards
  // in the same atomic D1 batch, including when cleanup resumes after a lost successful response.
  const statements = [
    ...guards.map(g => db.prepare(`DROP TRIGGER IF EXISTS ${g.name}`).bind()),
    db.prepare('DELETE FROM slack_ingress_chunks WHERE manifest_id IN (SELECT m.id FROM slack_ingress_manifests m JOIN slack_ingress i ON i.id=m.ingress_id WHERE i.event_id LIKE ?)').bind(`${probeId}-%`),
    db.prepare('DELETE FROM slack_ingress_manifests WHERE ingress_id IN (SELECT id FROM slack_ingress WHERE event_id LIKE ?)').bind(`${probeId}-%`),
    db.prepare('DELETE FROM cutover_producers WHERE id IN (SELECT id FROM slack_ingress WHERE event_id LIKE ?)').bind(`${probeId}-%`),
    db.prepare('DELETE FROM slack_ingress WHERE event_id LIKE ?').bind(`${probeId}-%`),
    ...guards.map(g => db.prepare(g.sql).bind()),
  ];
  await db.batch(statements);
  const counts = await db.prepare('SELECT (SELECT COUNT(*) FROM slack_ingress) AS events,(SELECT COUNT(*) FROM cutover_producers) AS producers,(SELECT COUNT(*) FROM slack_ingress_chunks) AS chunks,(SELECT COUNT(*) FROM slack_ingress_manifests) AS manifests')
    .bind().first();
  return Response.json({ cleaned: true, counts, guardsRestored: guards.length });
}

export default {
  async fetch(request: Request, env: RemoteProbeEnv): Promise<Response> {
    // No binding access before both credential and static target validation succeed.
    if (!validToken(request.headers.get('x-probe-token') ?? '', env.PROBE_TOKEN)) return new Response(null, { status: 404 });
    if (!validateProbeIdentity(env)) return Response.json({ error: 'invalid isolated target' }, { status: 503 });
    const url = new URL(request.url);
    if (!paths.has(url.pathname)) return new Response(null, { status: 404 });
    const counted = withIngressBudget({ DB: env.DB as unknown as D1Like });
    const db = counted.DB as unknown as D1Database;
    const reply = (response: Response): Response => {
      const headers = new Headers(response.headers);
      headers.set('x-probe-query-total', String(ingressBudget(counted.DB!)!.used));
      return new Response(response.body, { status: response.status, headers });
    };
    try {
      const owner = await db.prepare('SELECT probe_id,database_id,database_name FROM probe_ownership WHERE id=1').bind()
        .first<{ probe_id: string; database_id: string; database_name: string }>();
      if (!owner || owner.probe_id !== env.PROBE_ID || owner.database_id !== env.PROBE_DATABASE_ID
        || owner.database_name !== env.PROBE_DATABASE_NAME) return reply(Response.json({ error: 'binding ownership unknown' }, { status: 503 }));
      let response: Response;
      if (url.pathname === '/probe/health' && request.method === 'GET') {
        const guardCount = await db.prepare('SELECT COUNT(*) AS n FROM probe_guard_definitions').bind().first<{ n: number }>();
        response = Response.json({ ok: true, probeId: env.PROBE_ID, databaseId: env.PROBE_DATABASE_ID,
          databaseName: env.PROBE_DATABASE_NAME, peakWorkerMemory: null, guardCount: Number(guardCount?.n),
          cleanupStatements: 2 * Number(guardCount?.n) + 8 });
      } else {
        if (request.method !== 'POST') return reply(Response.json({ error: 'POST required' }, { status: 405 }));
        if (Number(request.headers.get('content-length') ?? 0) > 1_000_000) return reply(Response.json({ error: 'body too large' }, { status: 413 }));
        const raw = await request.clone().text();
        if (new TextEncoder().encode(raw).length > 1_000_000) return reply(Response.json({ error: 'body too large' }, { status: 413 }));
        const body = JSON.parse(raw) as Record<string, unknown>;
        const eventId = body.event_id ?? body.eventId;
        if (['/probe/accept', '/probe/store', '/probe/load', '/probe/inspect'].includes(url.pathname)
          && !scopedEvent(eventId, env.PROBE_ID)) return reply(Response.json({ error: 'event outside probe scope' }, { status: 400 }));
        if (['/probe/load', '/probe/fault'].includes(url.pathname)
          && (typeof body.ingressId !== 'string' || !body.ingressId.startsWith(`storage-proof:${env.PROBE_ID}-`))) {
          return reply(Response.json({ error: 'ingress outside probe scope' }, { status: 400 }));
        }
        if (url.pathname === '/probe/accept' && body.team_id !== 'T') return reply(Response.json({ error: 'unexpected team' }, { status: 400 }));
        if (url.pathname === '/probe/inspect') response = Response.json({ row: await inspect(db, eventId as string) });
        else if (url.pathname === '/probe/cleanup') {
          if (body.probeId !== env.PROBE_ID || !/^[a-f0-9]{64}$/.test(String(body.savedEvidenceSha256 ?? ''))) {
            return reply(Response.json({ error: 'saved readback evidence required' }, { status: 400 }));
          }
          response = await cleanup(db, env.PROBE_ID);
        } else if (url.pathname === '/probe/store') {
          if (!/^[a-f0-9]{64}$/.test(String(body.requestDigest ?? ''))) return reply(Response.json({ error: 'expected request digest required' }, { status: 400 }));
          const row = await db.prepare('SELECT state,(SELECT digest FROM slack_ingress_manifests WHERE id=i.manifest_id) AS digest FROM slack_ingress i WHERE id=?').bind(`storage-proof:${eventId}`)
            .first<{ state: string; digest: string | null }>();
          if (row) {
            // Resuming a published trial reads back; it cannot insert/replace its immutable request.
            const matching = row.state === 'ready' && row.digest === body.requestDigest;
            response = Response.json({ stored: matching, resumed: true,
              ingressId: `storage-proof:${eventId}`, row: await inspect(db, eventId as string) }, { status: matching ? 200 : 409 });
          } else response = await localProbe.fetch(request, { DB: db, CUTOVER_CONTROL: 'd1', SLACK_SIGNING_SECRET: env.PROBE_TOKEN });
        } else response = await localProbe.fetch(request, { DB: db, CUTOVER_CONTROL: 'd1', SLACK_SIGNING_SECRET: env.PROBE_TOKEN });
      }
      if (response.status === 200 && ((url.pathname === '/probe/accept' && request.headers.get('x-probe-drop-accept-response') === '1')
        || (url.pathname === '/probe/store' && request.headers.get('x-probe-drop-store-response') === '1')
        || (url.pathname === '/probe/cleanup' && request.headers.get('x-probe-drop-cleanup-response') === '1'))) {
        // Probe-only transport fault after the actual binding operation committed.
        response = Response.json({ outcome: 'unknown-after-commit' }, { status: 503 });
      }
      return reply(response);
    } catch (error) {
      const used = ingressBudget(counted.DB!)!.used;
      return Response.json({ error: error instanceof Error ? error.name : 'probe-failure', queries: used },
        { status: 500, headers: { 'x-probe-query-total': String(used) } });
    }
  },
};
