import { Hono } from 'hono';
import { dispatch, observe } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { Project } from './agents/project';
import { Retry, RetryOnce } from './agents/retry';
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
