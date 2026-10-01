import { Hono } from 'hono';
import { dispatch, observe } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { Project } from './agents/project';
import { Retry, RetryOnce } from './agents/retry';
import { Gw } from './agents/gw';
import { Gb, Gj, Gf } from './agents/gw2';
import { Pa, Pf, Pg, Pr, Pq, Ph, Hng, Stall, Sbx, SbxC } from './agents/probe';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { setProvider } from '@flue/runtime';

// ---- Q2: observe() at module scope. Runs in every isolate (Worker + each agent DO). -------------
// Persist what the observer sees to D1 so the Worker can read it back (DO isolate state is private).
const lastDelta = new Map<string, { at: number; n: number }>();
observe((event, ctx) => {
  void (async () => {
    try {
      const db = (ctx.env as any).DB as D1Database | undefined;
      if (!db) return;
      const now = Date.now();
      if ((event as any).type === 'submission_settled' && (event as any).submissionId) {
        await db.prepare('CREATE TABLE IF NOT EXISTS settled(submission_id TEXT PRIMARY KEY)').run();
        await db.prepare('INSERT OR IGNORE INTO settled(submission_id) VALUES (?)').bind((event as any).submissionId).run();
        await db.prepare('CREATE TABLE IF NOT EXISTS lastsettle(conv TEXT PRIMARY KEY, ts INTEGER)').run();
        await db.prepare('INSERT OR REPLACE INTO lastsettle(conv, ts) VALUES (?,?)').bind((event as any).instanceId, Date.now()).run();
      }
      const isDelta = event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta';
      if (isDelta) {
        const key = `${event.instanceId}:${event.type}`;
        const st = lastDelta.get(key) ?? { at: 0, n: 0 };
        st.n += 1;
        if (now - st.at < 250) return void lastDelta.set(key, st);
        const n = st.n;
        lastDelta.set(key, { at: now, n: 0 });
        await insert(db, now, event, { n });
        return;
      }
      const extra: Record<string, unknown> = {};
      const e = event as any;
      if (e.type === 'turn_request') {
        extra.systemPrompt = e.request?.input?.systemPrompt;
        extra.requestedModel = e.request?.requestedModel;
        extra.tail = (e.request?.input?.messages ?? []).slice(-3).map((m: any) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`.slice(0, 260));
      }
      if (e.type === 'message_start' || e.type === 'message_end') extra.role = e.message?.role;
      if (e.type === 'tool' || e.type === 'tool_start') Object.assign(extra, { toolName: e.toolName, isError: e.isError, result: JSON.stringify(e.result ?? null).slice(0, 300) });
      if (e.type === 'operation' || e.type === 'turn') Object.assign(extra, { isError: e.isError, error: e.error ?? e.response?.error?.message, finishReason: e.response?.finishReason });
      if (e.type === 'agent_end') extra.lastStop = (e.messages ?? []).slice(-1).map((m: any) => ({ role: m.role, stopReason: m.stopReason, err: m.errorMessage }));
      if (e.type === 'submission_running') Object.assign(extra, { attemptCount: e.attemptCount, maxAttempts: e.maxAttempts });
      if (e.type === 'submission_recovery') Object.assign(extra, { operation: e.operation, outcome: e.outcome, attemptCount: e.attemptCount, error: e.error?.message });
      if (e.type === 'submission_settled') Object.assign(extra, { outcome: e.outcome, error: e.error });
      if (e.type === 'log') Object.assign(extra, { message: e.message, attributes: e.attributes });
      await insert(db, now, event, extra);
    } catch (err) {
      console.log('[observe] failed', err instanceof Error ? err.message : String(err));
    }
  })();
});

async function insert(db: D1Database, now: number, event: any, extra: Record<string, unknown>) {
  await db
    .prepare('INSERT INTO events(ts, type, instance_id, submission_id, event_index, body) VALUES (?,?,?,?,?,?)')
    .bind(now, event.type, event.instanceId ?? null, event.submissionId ?? null, event.eventIndex ?? null, JSON.stringify(extra))
    .run();
}

const app = new Hono<{ Bindings: { DB: D1Database } }>();

async function ensureSchema(db: D1Database) {
  await db.prepare('CREATE TABLE IF NOT EXISTS bindings(project_id TEXT PRIMARY KEY, persona TEXT, model TEXT)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS memories(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, fact TEXT)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS tool_calls(instance_id TEXT, submission_id TEXT, attempt_ts INTEGER)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS replies(instance_id TEXT, submission_id TEXT, text TEXT, ts INTEGER)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, instance_id TEXT, submission_id TEXT, event_index INTEGER, body TEXT)').run();
}

// Debug routes (spike only).
app.post('/seed', async (c) => {
  const { projectId, persona, model, facts } = await c.req.json<{ projectId: string; persona: string; model?: string; facts?: string[] }>();
  await ensureSchema(c.env.DB);
  await c.env.DB.prepare('INSERT OR REPLACE INTO bindings(project_id, persona, model) VALUES (?,?,?)').bind(projectId, persona, model ?? null).run();
  await c.env.DB.prepare('DELETE FROM memories WHERE project_id=?').bind(projectId).run();
  for (const f of facts ?? []) await c.env.DB.prepare('INSERT INTO memories(project_id, fact) VALUES (?,?)').bind(projectId, f).run();
  return c.json({ ok: true });
});
app.post('/reset-events', async (c) => {
  await ensureSchema(c.env.DB);
  await c.env.DB.prepare('DELETE FROM events').run();
  return c.json({ ok: true });
});
app.get('/events', async (c) => {
  await ensureSchema(c.env.DB);
  const inst = c.req.query('instance');
  const q = inst
    ? c.env.DB.prepare('SELECT seq, ts, type, instance_id, submission_id, event_index, body FROM events WHERE instance_id=? ORDER BY seq').bind(inst)
    : c.env.DB.prepare('SELECT seq, ts, type, instance_id, submission_id, event_index, body FROM events ORDER BY seq');
  return c.json((await q.all()).results);
});
app.post('/go', async (c) => {
  const body = await c.req.json<any>();
  try {
    const receipt = await dispatch(Project, body);
    return c.json({ receipt });
  } catch (e) {
    return c.json({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, 500);
  }
});

app.get('/rows', async (c) => {
  await ensureSchema(c.env.DB);
  const tc = (await c.env.DB.prepare('SELECT * FROM tool_calls ORDER BY rowid').all()).results;
  const rp = (await c.env.DB.prepare('SELECT * FROM replies ORDER BY rowid').all()).results;
  return c.json({ tool_calls: tc, replies: rp });
});
app.post('/reset-rows', async (c) => {
  await ensureSchema(c.env.DB);
  await c.env.DB.prepare('DELETE FROM tool_calls').run();
  await c.env.DB.prepare('DELETE FROM replies').run();
  await c.env.DB.prepare('DELETE FROM events').run();
  return c.json({ ok: true });
});
app.post('/go2', async (c) => {
  const { agent, ...req } = await c.req.json<any>();
  try {
    return c.json({ receipt: await dispatch(agent === 'once' ? RetryOnce : Retry, req) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, 500);
  }
});
// ---- native-first audit probes ------------------------------------------------------------
setProvider(
  createProvider({
    id: 'stall',
    auth: { apiKey: { name: 'keyless', resolve: async () => ({ auth: { apiKey: 'stall-key' } }) } },
    models: [
      { id: 'm1', name: 'stall', api: 'openai-completions', provider: 'stall', baseUrl: 'http://localhost:5288/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 },
    ],
    api: openAICompletionsApi(),
  } as any),
);
const PROBES: Record<string, any> = { pg: Pg, pq: Pq, ph: Ph, pr: Pr, pa: Pa, pf: Pf, hng: Hng, stall: Stall, sbx: Sbx, sbxc: SbxC };
app.post('/probe', async (c) => {
  const { agent, ...req } = await c.req.json<any>();
  await c.env.DB.prepare('CREATE TABLE IF NOT EXISTS plog(seq INTEGER PRIMARY KEY AUTOINCREMENT, instance_id TEXT, ts INTEGER, what TEXT, extra TEXT)').run();
  try {
    const seq = (req as any).message?.attributes?.seq;
    if (seq) { await c.env.DB.prepare('CREATE TABLE IF NOT EXISTS marks(instance_id TEXT, seq INTEGER)').run(); await c.env.DB.prepare('INSERT INTO marks(instance_id, seq) VALUES (?,?)').bind((req as any).id, Number(seq)).run(); }
    return c.json({ receipt: await dispatch(PROBES[agent], req) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, 500);
  }
});
app.get('/plog', async (c) => {
  await c.env.DB.prepare('CREATE TABLE IF NOT EXISTS plog(seq INTEGER PRIMARY KEY AUTOINCREMENT, instance_id TEXT, ts INTEGER, what TEXT, extra TEXT)').run();
  const inst = c.req.query('instance');
  const q = inst ? c.env.DB.prepare('SELECT * FROM plog WHERE instance_id=? ORDER BY seq').bind(inst) : c.env.DB.prepare('SELECT * FROM plog ORDER BY seq');
  return c.json((await q.all()).results);
});
app.post('/plog-reset', async (c) => {
  await c.env.DB.prepare('CREATE TABLE IF NOT EXISTS plog(seq INTEGER PRIMARY KEY AUTOINCREMENT, instance_id TEXT, ts INTEGER, what TEXT, extra TEXT)').run();
  await c.env.DB.prepare('DELETE FROM plog').run();
  await c.env.DB.prepare('DELETE FROM events').run();
  return c.json({ ok: true });
});

// ---- owner-approved burst design: gateway simulation ---------------------------------------------
async function gwSchema(db: D1Database) {
  await db.prepare('CREATE TABLE IF NOT EXISTS claims(event_id TEXT PRIMARY KEY)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS inflight(conv TEXT, submission_id TEXT)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS settled(submission_id TEXT PRIMARY KEY)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS gwrows(seq INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, kind TEXT, key TEXT, text TEXT, extra TEXT, ts INTEGER)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS lastsettle(conv TEXT PRIMARY KEY, ts INTEGER)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS gwcap(conv TEXT PRIMARY KEY, n INTEGER)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS gwmsgs(event_id TEXT PRIMARY KEY, burst TEXT, conv TEXT, sender TEXT, token TEXT, text TEXT, path TEXT, submission_id TEXT, ts INTEGER)').run();
}
app.post('/gw-reset', async (c) => {
  await gwSchema(c.env.DB);
  for (const t of ['claims', 'inflight', 'settled', 'gwrows', 'gwmsgs', 'gwcap', 'lastsettle', 'events']) await c.env.DB.prepare(`DELETE FROM ${t}`).run();
  return c.json({ ok: true });
});
let gwPolicy: { policy: 'A' | 'B' | 'C'; windowMs: number; cooldownMs?: number } = { policy: 'A', windowMs: 2000 };
const gwBatches = new Map<string, { msgs: any[]; deadline: number }>();
app.post('/gw-config', async (c) => {
  gwPolicy = await c.req.json();
  return c.json(gwPolicy);
});
async function gwFlush(db: D1Database, conv: string, msgs: any[]) {
  // Policy B flush: ONE ack, ONE dispatch for the whole batch. In-memory timer = spike only; production needs a durable timer.
  const ackTs = `ack-${crypto.randomUUID().slice(0, 6)}`;
  await db.prepare('INSERT INTO gwrows(conv, kind, key, text, extra, ts) VALUES (?,?,?,?,?,?)').bind(conv, 'ack', ackTs, 'Working...', '', Date.now()).run();
  const ids = msgs.map((m) => m.event_id);
  const body = msgs.map((m) => `[${m.sender}] ${m.text}`).join('\n');
  const attrs: Record<string, string> = { sender: msgs[msgs.length - 1].sender, senders: [...new Set(msgs.map((m) => m.sender))].join(','), eventIds: ids.join(','), count: String(msgs.length), ackTs };
  const receipt = await dispatch(Gw, { id: conv, idempotencyKey: `batch:${ids.join('+')}`.slice(0, 256), message: { kind: 'signal', type: 'slack.message', body, attributes: attrs } });
  if (!receipt.deduplicated) await db.prepare('INSERT INTO inflight(conv, submission_id) VALUES (?,?)').bind(conv, receipt.submissionId).run();
  for (const id of ids) await db.prepare('UPDATE gwmsgs SET submission_id=? WHERE event_id=?').bind(receipt.submissionId, id).run();
}
app.post('/gw', async (c) => {
  const db = c.env.DB;
  const b = await c.req.json<{ event_id: string; conv: string; sender: string; text: string; token: string; burst: string; model?: string }>();
  await gwSchema(db);
  // 1. claim the event id (real system: KV claim). Duplicate redelivery stops here.
  const claim = (await db.prepare('INSERT OR IGNORE INTO claims(event_id) VALUES (?)').bind(b.event_id).run()) as any;
  if (!(claim?.meta?.changes ?? 0)) return c.json({ dup: true });
  // 2. in flight? = accepted-but-unsettled submissions for this conversation (fed by observe() settled events).
  const n = await db.prepare('SELECT COUNT(*) AS n FROM inflight WHERE conv=? AND submission_id NOT IN (SELECT submission_id FROM settled)').bind(b.conv).first<{ n: number }>();
  const busy = (n?.n ?? 0) > 0;
  // Policy C: debounce only inside the cooldown after a settle; otherwise behave like A.
  let cWindow = false;
  if (gwPolicy.policy === 'C' && !busy) {
    if (gwBatches.has(b.conv)) cWindow = true;
    else {
      const ls = await db.prepare('SELECT ts FROM lastsettle WHERE conv=?').bind(b.conv).first<{ ts: number }>();
      if (ls && Date.now() - ls.ts < (gwPolicy.cooldownMs ?? 3000)) {
        cWindow = true;
        await db.prepare('INSERT INTO gwrows(conv, kind, key, text, extra, ts) VALUES (?,?,?,?,?,?)').bind(b.conv, 'c_window', b.event_id, '', '', Date.now()).run();
      }
    }
  }
  if ((gwPolicy.policy === 'B' || cWindow) && !busy) {
    let batch = gwBatches.get(b.conv);
    if (!batch) {
      batch = { msgs: [], deadline: Date.now() + gwPolicy.windowMs };
      gwBatches.set(b.conv, batch);
      const bt = batch;
      c.executionCtx.waitUntil(
        (async () => {
          while (Date.now() < bt.deadline) await new Promise((r) => setTimeout(r, 40));
          gwBatches.delete(b.conv);
          await gwFlush(db, b.conv, bt.msgs);
        })(),
      );
    }
    batch.msgs.push(b);
    batch.deadline = Date.now() + gwPolicy.windowMs;
    await db.prepare('INSERT INTO gwmsgs(event_id, burst, conv, sender, token, text, path, submission_id, ts) VALUES (?,?,?,?,?,?,?,?,?)').bind(b.event_id, b.burst, b.conv, b.sender, b.token, b.text, 'debounced', '', Date.now()).run();
    return c.json({ path: 'debounced' });
  }
  const attrs: Record<string, string> = { sender: b.sender, eventId: b.event_id, ...(b.model ? { model: b.model } : {}) };
  let path: string;
  if (busy) {
    path = 'eyes';
    await db.prepare('INSERT INTO gwrows(conv, kind, key, text, extra, ts) VALUES (?,?,?,?,?,?)').bind(b.conv, 'eyes', b.event_id, '', '', Date.now()).run();
  } else {
    path = 'ack';
    const ackTs = `ack-${crypto.randomUUID().slice(0, 6)}`;
    attrs.ackTs = ackTs;
    await db.prepare('INSERT INTO gwrows(conv, kind, key, text, extra, ts) VALUES (?,?,?,?,?,?)').bind(b.conv, 'ack', ackTs, 'Working...', '', Date.now()).run();
  }
  const receipt = await dispatch(Gw, { id: b.conv, idempotencyKey: b.event_id, message: { kind: 'signal', type: 'slack.message', body: b.text, attributes: attrs } });
  if (!receipt.deduplicated) await db.prepare('INSERT INTO inflight(conv, submission_id) VALUES (?,?)').bind(b.conv, receipt.submissionId).run();
  await db.prepare('INSERT INTO gwmsgs(event_id, burst, conv, sender, token, text, path, submission_id, ts) VALUES (?,?,?,?,?,?,?,?,?)').bind(b.event_id, b.burst, b.conv, b.sender, b.token, b.text, path, receipt.submissionId, Date.now()).run();
  return c.json({ path, submissionId: receipt.submissionId });
});
app.get('/gw-state', async (c) => {
  await gwSchema(c.env.DB);
  const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM inflight WHERE submission_id NOT IN (SELECT submission_id FROM settled)').first<{ n: number }>();
  return c.json({ inflight: n?.n ?? 0, batches: gwBatches.size });
});
app.get('/gw-fail', async (c) => {
  const conv = c.req.query('conv') ?? '';
  const r = (await c.env.DB.prepare("SELECT body FROM events WHERE type='submission_settled' AND instance_id=?").bind(conv).all<{ body: string }>()).results ?? [];
  return c.json(r.map((x) => JSON.parse(x.body)));
});
app.get('/gw-dump', async (c) => {
  await gw2Schema(c.env.DB);
  const q = async (sql: string) => (await c.env.DB.prepare(sql).all()).results;
  return c.json({
    msgs: await q('SELECT * FROM gwmsgs ORDER BY ts'),
    rows: await q('SELECT * FROM gwrows ORDER BY seq'),
    events: await q("SELECT ts, type, instance_id, submission_id, body FROM events WHERE type IN ('submission_queued','submission_running','submission_settled','tool_start','turn_request') ORDER BY seq"),
    pending: await q('SELECT * FROM pending ORDER BY id'),
  });
});

// ---- final-text-as-reply comparison (gw2): arms base | j | f ---------------------------------------
async function gw2Schema(db: D1Database) {
  await gwSchema(db);
  await db.prepare('CREATE TABLE IF NOT EXISTS pending(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, sender TEXT, text TEXT, event_id TEXT, status TEXT, created_at INTEGER)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS lastparts(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, text TEXT, posted INTEGER)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS lasttext(conv TEXT PRIMARY KEY, text TEXT, posted INTEGER, ts INTEGER)').run();
}
let gw2Arm: 'base' | 'j' | 'f' | 'f2' = 'j';
const GW2_AGENTS: Record<string, any> = { base: Gb, j: Gj, f: Gf, f2: Gf };
app.post('/gw2-config', async (c) => {
  gw2Arm = (await c.req.json<{ arm: 'base' | 'j' | 'f' | 'f2' }>()).arm;
  return c.json({ arm: gw2Arm });
});
app.post('/gw2-reset', async (c) => {
  await gw2Schema(c.env.DB);
  for (const t of ['claims', 'inflight', 'settled', 'gwrows', 'gwmsgs', 'gwcap', 'lastsettle', 'pending', 'lasttext', 'lastparts', 'events']) await c.env.DB.prepare(`DELETE FROM ${t}`).run();
  return c.json({ ok: true });
});
async function gw2Dispatch(db: D1Database, conv: string, attrs: Record<string, string>, body: string, key: string) {
  const receipt = await dispatch(GW2_AGENTS[gw2Arm], { id: conv, idempotencyKey: key, message: { kind: 'signal', type: 'slack.message', body, attributes: attrs } });
  if (!receipt.deduplicated) await db.prepare('INSERT INTO inflight(conv, submission_id) VALUES (?,?)').bind(conv, receipt.submissionId).run();
  return receipt;
}
const gw2Row = (db: D1Database, conv: string, kind: string, key: string, text: string) =>
  db.prepare('INSERT INTO gwrows(conv, kind, key, text, extra, ts) VALUES (?,?,?,?,?,?)').bind(conv, kind, key, text, '', Date.now()).run();
app.post('/gw2', async (c) => {
  const db = c.env.DB;
  const b = await c.req.json<{ event_id: string; conv: string; sender: string; text: string; token: string; burst: string }>();
  await gw2Schema(db);
  const claim = (await db.prepare('INSERT OR IGNORE INTO claims(event_id) VALUES (?)').bind(b.event_id).run()) as any;
  if (!(claim?.meta?.changes ?? 0)) return c.json({ dup: true });
  const n = await db.prepare('SELECT COUNT(*) AS n FROM inflight WHERE conv=? AND submission_id NOT IN (SELECT submission_id FROM settled)').bind(b.conv).first<{ n: number }>();
  const busy = (n?.n ?? 0) > 0;
  const attrs: Record<string, string> = { sender: b.sender, eventId: b.event_id };
  let path: string;
  let submissionId = '';
  if (busy && gw2Arm === 'base') {
    // ARM:BASE:start (gate: park instead of dispatch)
    path = 'parked';
    await db.prepare("INSERT INTO pending(conv, sender, text, event_id, status, created_at) VALUES (?,?,?,?, 'pending', ?)").bind(b.conv, b.sender, b.text, b.event_id, Date.now()).run();
    await gw2Row(db, b.conv, 'eyes', b.event_id, '');
    // ARM:BASE:end
  } else if (busy) {
    path = 'eyes';
    await gw2Row(db, b.conv, 'eyes', b.event_id, '');
    submissionId = (await gw2Dispatch(db, b.conv, attrs, b.text, b.event_id)).submissionId;
  } else {
    path = 'ack';
    attrs.ackTs = `ack-${crypto.randomUUID().slice(0, 6)}`;
    await db.prepare('INSERT INTO gwrows(conv, kind, key, text, extra, ts) VALUES (?,?,?,?,?,?)').bind(b.conv, 'ack', attrs.ackTs, 'Working...', '', Date.now()).run();
    submissionId = (await gw2Dispatch(db, b.conv, attrs, b.text, b.event_id)).submissionId;
  }
  await db.prepare('INSERT INTO gwmsgs(event_id, burst, conv, sender, token, text, path, submission_id, ts) VALUES (?,?,?,?,?,?,?,?,?)').bind(b.event_id, b.burst, b.conv, b.sender, b.token, b.text, path, submissionId, Date.now()).run();
  return c.json({ path });
});
// ARM:BASE:start (sweep: combined turn for parked rows older than the grace window with no turn in flight)
app.post('/gw2-sweep', async (c) => {
  const db = c.env.DB;
  await gw2Schema(db);
  const GRACE_MS = 20_000; // sim value; production SWEEP_GRACE_MS is 30 s and the cron tick is 2 min
  const convs = (await db.prepare("SELECT DISTINCT conv FROM pending WHERE status='pending' AND created_at < ?").bind(Date.now() - GRACE_MS).all<{ conv: string }>()).results ?? [];
  let swept = 0;
  for (const { conv } of convs) {
    const n = await db.prepare('SELECT COUNT(*) AS n FROM inflight WHERE conv=? AND submission_id NOT IN (SELECT submission_id FROM settled)').bind(conv).first<{ n: number }>();
    if ((n?.n ?? 0) > 0) continue;
    const rows = (await db.prepare("SELECT id, sender, text, event_id FROM pending WHERE conv=? AND status='pending' ORDER BY id").bind(conv).all<{ id: number; sender: string; text: string; event_id: string }>()).results ?? [];
    if (!rows.length) continue;
    for (const r of rows) await db.prepare("UPDATE pending SET status='dispatched' WHERE id=? AND status='pending'").bind(r.id).run();
    const ackTs = `ack-${crypto.randomUUID().slice(0, 6)}`;
    await db.prepare('INSERT INTO gwrows(conv, kind, key, text, extra, ts) VALUES (?,?,?,?,?,?)').bind(conv, 'ack', ackTs, 'Working...', '', Date.now()).run();
    await gw2Row(db, conv, 'sweep', String(rows.length), '');
    const body = rows.length === 1 ? rows[0].text : rows.map((r) => `[${r.sender}]: ${r.text}`).join('\n');
    await gw2Dispatch(db, conv, { sender: rows[rows.length - 1].sender, ackTs }, body, `sweep:${rows.map((r) => r.event_id).join('+')}`.slice(0, 256));
    swept++;
  }
  return c.json({ swept });
});
// ARM:BASE:end
app.get('/gw2-state', async (c) => {
  await gw2Schema(c.env.DB);
  const a = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM inflight WHERE submission_id NOT IN (SELECT submission_id FROM settled)').first<{ n: number }>();
  const p = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM pending WHERE status='pending'").first<{ n: number }>();
  return c.json({ inflight: a?.n ?? 0, pending: p?.n ?? 0 });
});
// ARM:F:start (final-text capture and post, observer side; one chain per isolate keeps D1 writes in event order)
let fChain: Promise<void> = Promise.resolve();
observe((event, ctx) => {
  const e = event as any;
  const conv = e.instanceId as string | undefined;
  if (!conv || !(conv.includes('/conv:F-') || conv.includes('/conv:F2-')) || (e.type !== 'message_end' && e.type !== 'submission_settled')) return;
  fChain = fChain.then(async () => {
    try {
      const db = (ctx.env as any).DB as D1Database;
      if (e.type === 'message_end') {
        const blocks: any[] = Array.isArray(e.message?.content) ? e.message.content : [];
        if (e.message?.role !== 'assistant' || blocks.some((b) => b.type === 'toolCall')) return; // intermediate (tool-call) messages are never captured
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        await db.prepare('INSERT OR REPLACE INTO lasttext(conv, text, posted, ts) VALUES (?,?,0,?)').bind(conv, text, Date.now()).run();
        // F2 fix attempt: keep the text of every cycle-final (no-tool) assistant message, not just the last one.
        if (conv.includes('/conv:F2-') && text) await db.prepare('INSERT INTO lastparts(conv, text, posted) VALUES (?,?,0)').bind(conv, text).run();
        return;
      }
      if (e.outcome !== 'completed') return;
      const last = await db.prepare('SELECT text FROM lasttext WHERE conv=? AND posted=0').bind(conv).first<{ text: string }>();
      if (!last) return;
      await db.prepare('UPDATE lasttext SET posted=1 WHERE conv=?').bind(conv).run();
      let postText = last.text;
      if (conv.includes('/conv:F2-')) {
        const parts = (await db.prepare('SELECT text FROM lastparts WHERE conv=? AND posted=0 ORDER BY id').bind(conv).all<{ text: string }>()).results ?? [];
        await db.prepare('UPDATE lastparts SET posted=1 WHERE conv=?').bind(conv).run();
        postText = parts.map((x) => x.text).join('\n\n');
      }
      if (!postText) { await gw2Row(db, conv, 'empty_final', '', ''); return; }
      const ack = await db.prepare("SELECT key FROM gwrows WHERE conv=? AND kind='ack' AND extra!='edited' ORDER BY seq LIMIT 1").bind(conv).first<{ key: string }>();
      if (ack) await db.prepare("UPDATE gwrows SET text=?, extra='edited' WHERE conv=? AND kind='ack' AND key=?").bind(postText, conv, ack.key).run();
      await gw2Row(db, conv, 'post', '', postText);
    } catch (err) {
      console.log('[gw2 observer]', err instanceof Error ? err.message : String(err));
    }
  });
});
// ARM:F:end

app.route('/agents/pa', createAgentRouter(Pa));
app.route('/agents/pq', createAgentRouter(Pq));
app.route('/agents/pg', createAgentRouter(Pg));
app.route('/agents/ph', createAgentRouter(Ph));
app.route('/agents/pr', createAgentRouter(Pr));
app.route('/agents/pf', createAgentRouter(Pf));
app.route('/agents/hng', createAgentRouter(Hng));
app.route('/agents/stall', createAgentRouter(Stall));
app.route('/agents/sbx', createAgentRouter(Sbx));
app.route('/agents/sbxc', createAgentRouter(SbxC));
app.route('/agents/project', createAgentRouter(Project));
app.route('/agents/retry', createAgentRouter(Retry));
app.route('/agents/retry-once', createAgentRouter(RetryOnce));

export default app;
