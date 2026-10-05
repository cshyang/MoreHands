import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { deferred } from './test-fixtures';
import { ingressDbFixture } from '../slack/test-utils/ingress-db';
import type { IngressDb, BoundD1Statement } from '../slack/ingress-store';
import type { D1Like } from '../skills/repository';
import type { ProjectDispatchRequest } from '../gateway/dispatch';
import type { ThreadMessage } from '../slack/threads';

const require = createRequire(new URL('../app.ts', import.meta.url));
export async function ingressFixture(state: 'open' | 'closed' = 'closed') {
  const f = ingressDbFixture(state);
  f.sql.exec(`INSERT INTO bindings(project_id,provider,external_account_id,external_space_id,transport_bot_id,
    transport_token_ref,status,created_at,updated_at) VALUES('P','slack','T','C','BOT','TEST_SLACK_TOKEN','active',0,0)`);
  const effects: string[] = [];
  const dispatchRequests: ProjectDispatchRequest[] = [];
  const nativeRequests: import('@flue/runtime').AgentDispatchRequest[] = [];
  let realInternalPreparation = false;
  let history: ThreadMessage[] = [];
  let privateBody = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
  let failDb = false;
  let failNative = false;
  let holdAck = false;
  let throwScheduling = false;
  const ackPost = deferred<Response>();
  const ackStarted = deferred<void>();
  const originalStatements = new WeakMap<object, BoundD1Statement>();
  const db: IngressDb = { prepare: query => {
    if (failDb) throw new Error('test database unavailable');
    return { bind: (...values) => {
      const actual = f.db.prepare(query).bind(...values);
      const wrapped = { ...actual, run: async () => {
        if (!query.includes('cutover_')) effects.push(`sql:${query.trim().split(/\s+/).slice(0, 3).join(' ')}`);
        return actual.run();
      } };
      originalStatements.set(wrapped, actual); return wrapped;
    } };
  }, batch: statements => {
    if (failDb) throw new Error('test database unavailable');
    return f.db.batch(statements.map(s => originalStatements.get(s) ?? s));
  } };
  const runnerDispatch = deferred<Response>();
  const runnerStarted = deferred<void>();
  const oldFetch = globalThis.fetch;
  const assertHistoryScope = (url: string) => {
    if (new URL(url).searchParams.get('channel') !== 'C') throw new Error('unexpected history scope');
  };
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    effects.push(`fetch:${new URL(url).pathname}`);
    if (url === 'https://api.trigger.dev/api/v1/tasks/run-coding-task/trigger') {
      runnerStarted.resolve();
      return runnerDispatch.promise;
    }
    if (url.startsWith('https://slack.com/api/files.info')) {
      const fileId = new URL(url).searchParams.get('file');
      return Response.json({ ok: true, file: { id: fileId, url_private_download: `https://files.slack.com/files-pri/${fileId}` } });
    }
    if (url.startsWith('https://slack.com/api/conversations.')) {
      assertHistoryScope(url);
      return Response.json({ ok: true, messages: url.includes('conversations.history') ? history.slice().reverse() : history });
    }
    if (url.startsWith('https://slack.com/api/')) {
      if (holdAck && url.endsWith('/chat.postMessage')) { ackStarted.resolve(); return ackPost.promise; }
      return Response.json({ ok: true, ts: '2.0', messages: [] });
    }
    if (url.startsWith('https://files.slack.com/')) {
      return new Response(privateBody, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    throw new Error(`unexpected external request: ${url}`);
  };
  globalThis.fetch = fakeFetch;
  const exported: Record<string, any> = {};
  const output = ts.transpileModule(readFileSync(new URL('../app.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const modules = new Map<string, unknown>();
  for (const match of output.matchAll(/require\("([^"]+)"\)/g)) {
    const name = match[1];
    if (name === '@flue/runtime' || name === './gateway/dispatch') continue;
    if (name === './gateway/slack-ingress') {
      const recovery = await import('../gateway/slack-ingress');
      const gateway = await import('../gateway/dispatch');
      modules.set(name, { recoverSlackIngress: (env: Record<string, unknown>, options: Parameters<typeof recovery.recoverSlackIngress>[1]) =>
        recovery.recoverSlackIngress(env, options, {
          prepare: async (env, request, options) => { dispatchRequests.push(request); return gateway.prepareProjectDispatch(env, request, options); },
          dispatch: async request => {
            nativeRequests.push(request);
            effects.push('native-dispatch');
            if (failNative) throw new Error('native boundary unknown');
            return { submissionId: 'submission-1', uid: 'uid-1', acceptedAt: '2026-10-04T00:00:00Z' };
          },
        }) });
      continue;
    }
    if (name === './gateway/scheduled-dispatch') {
      const helper: Record<string, any> = {};
      const helperOutput = ts.transpileModule(readFileSync(new URL('../gateway/scheduled-dispatch.ts', import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const imports = new Map<string, unknown>();
      for (const match of helperOutput.matchAll(/require\("([^"]+)"\)/g)) {
        if (match[1] !== './dispatch') imports.set(match[1], await import(new URL(`../gateway/${match[1]}.ts`, import.meta.url).href));
      }
      runInNewContext(helperOutput, { exports: helper, Date, require: (dependency: string) => dependency === './dispatch'
        ? { dispatchProject: async () => { effects.push('native-dispatch'); if (failNative) throw new Error('native boundary unknown'); } }
        : imports.get(dependency) });
      modules.set(name, helper);
    } else modules.set(name, name.startsWith('.') ? await import(new URL(`../${name}.ts`, import.meta.url).href) : require(name));
  }
  runInNewContext(output, {
    exports: exported,
    require: (name: string) => {
      if (name === '@flue/runtime') return { observe() {} };
      if (name === './gateway/dispatch') return { dispatchProject: async (_env: unknown, request: ProjectDispatchRequest) => {
        dispatchRequests.push(request);
        if (realInternalPreparation) await (await import('../gateway/dispatch')).prepareProjectDispatch(_env as Record<string, unknown>, request);
        effects.push('native-dispatch');
        if (failNative) throw new Error('native boundary unknown');
        return { submissionId: 'submission-1', uid: 'uid-1', acceptedAt: '2026-10-04T00:00:00Z' };
      } };
      if (!modules.has(name)) throw new Error(`unexpected import: ${name}`);
      return modules.get(name);
    },
    crypto, Request, Response, TextEncoder, TextDecoder, URL, Date, console, fetch: fakeFetch,
  });
  const jobs: Promise<unknown>[] = [];
  const kv = new Map<string, string>();
  const env = {
    DB: db, CUTOVER_CONTROL: 'd1', HEARTBEAT_TOKEN: 'test-internal', SLACK_SIGNING_SECRET: 'test-slack-signing',
    ADMIN_CONNECTIONS_TOKEN: 'test-admin', LINEAR_WEBHOOK_SECRET: 'test-linear-signing', KNOWN_TEAM_IDS: 'T', SLACK_BOT_ID: 'BOT',
    TEST_SLACK_TOKEN: 'test-slack-token', WORKBENCH_RUNNER_TOKEN: 'test-source', AGENT_RUNNER_TOKEN: 'test-runner',
    MOREHANDS_PUBLIC_URL: 'https://fixture.example', TRIGGER_SECRET_KEY: 'test-trigger', RUNNER_GITHUB_PAT_TEMP: 'test-github',
    LINEAR_AGENT_PROJECTS: JSON.stringify({ LIN: { projectId: 'P', targetRepo: 'github.com/example/repo' } }),
    SLACK_EVENTS: { get: async (key: string) => kv.get(key) ?? null, put: async (key: string, value: string) => {
      effects.push('kv-claim'); kv.set(key, value);
    } },
  };
  const request = (path: string, raw: string, headers: Record<string, string> = {}) => exported.default.fetch(
    new Request(`https://fixture.example${path}`, { method: 'POST', body: raw, headers }), env,
    { waitUntil: (job: Promise<unknown>) => { jobs.push(job); if (throwScheduling) throw new Error('fixture scheduling unavailable'); }, passThroughOnException() {} },
  ) as Promise<Response>;
  const mac = async (key: string, raw: string) => {
    const signing = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return Buffer.from(await crypto.subtle.sign('HMAC', signing, new TextEncoder().encode(raw))).toString('hex');
  };
  const slackRaw = async (path: string, raw: string) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return request(path, raw, { 'x-slack-request-timestamp': timestamp,
      'x-slack-signature': `v0=${await mac(env.SLACK_SIGNING_SECRET, `v0:${timestamp}:${raw}`)}` });
  };
  return {
    ...f, env, effects, dispatchRequests, nativeRequests, runnerDispatch, runnerStarted, app: exported.default, scheduledHelper: modules.get('./gateway/scheduled-dispatch'),
    setHistory: (messages: ThreadMessage[]) => { history = messages; },
    setPrivateBody: (body: Buffer) => { privateBody = body; },
    signedSlack: (body: Record<string, unknown>) => slackRaw('/slack/events', JSON.stringify(body)),
    unsignedSlack: () => request('/slack/events', '{}'),
    admin: (path: string, body: unknown) => request(path, JSON.stringify(body), { 'x-morehands-admin-token': 'test-admin' }),
    adminStatus: () => exported.default.fetch(new Request('https://fixture.example/__admin/cutover/status', {
      headers: { 'x-morehands-admin-token': 'test-admin' },
    }), env, { waitUntil: (job: Promise<unknown>) => jobs.push(job) }) as Promise<Response>,
    commands: () => slackRaw('/slack/commands', 'team_id=T&channel_id=C&text=status'),
    internal: (path: string, body: unknown, headers: Record<string, string> = {}) => request(path, JSON.stringify(body), {
      'x-morehands-token': env.HEARTBEAT_TOKEN, 'content-type': 'application/json', ...headers,
    }),
    signedLinear: async (body: Record<string, unknown>, event: 'Issue' | 'Comment', valid = true) => {
      const raw = JSON.stringify(body);
      return request('/linear/webhook', raw, { 'linear-event': event, 'linear-delivery': 'delivery-1',
        'linear-signature': valid ? await mac(env.LINEAR_WEBHOOK_SECRET, raw) : 'invalid' });
    },
    count: () => Number(f.sql.prepare('SELECT COUNT(*) AS n FROM cutover_producers').get()!.n),
    close: async () => { f.sql.exec("UPDATE cutover_control SET state='closed',revision=revision+1"); },
    failDatabase: () => { failDb = true; },
    failDispatch: () => { failNative = true; },
    resumeDispatch: () => { failNative = false; },
    useRealInternalPreparation: () => { realInternalPreparation = true; },
    holdAcknowledgement: () => { holdAck = true; return { ...ackPost, started: ackStarted.promise }; },
    throwOnScheduling: () => { throwScheduling = true; },
    finishJobs: async () => { while (jobs.length) await Promise.all(jobs.splice(0)); },
    dispose: () => { globalThis.fetch = oldFetch; f.sql.close(); },
  };
}

export function slackMessage() {
  return { type: 'event_callback', event_id: 'E', team_id: 'T',
    event: { type: 'message', channel: 'C', user: 'U', ts: '1.0', text: '<@BOT> hi' } };
}
export function linearIssue() {
  return { action: 'update', type: 'Issue', webhookTimestamp: Date.now(), organizationId: 'org',
    data: { id: 'issue-1', identifier: 'LIN-1', title: 'Fix bug', description: 'Fix it',
      url: 'https://linear.app/example/issue/LIN-1', team: { id: 'team-1', key: 'LIN', name: 'Team' },
      state: { id: 'state-1', name: 'Run Agent' } }, updatedFrom: { state: { name: 'Backlog' } } };
}
