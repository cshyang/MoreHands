// Native dispatch envelope invariants — run: npx tsx src/gateway/dispatch.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { projectDispatchMessage } from './dispatch-message';
import { agentInstanceId } from '../project/bindings';
import { conversationScope } from '../project/conversations';
import { ingressFixture } from '../cutover/ingress-test-fixture';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { ProjectDispatchRequest } from './dispatch-message';
import { ProjectAdmissionError } from './dispatch-message';
import { prepareProjectDispatch } from './dispatch';
import { loadProjectContext } from '../agent/context';
import { route as frozenRoute } from '../slack/test-utils/frozen-request';

async function gatewayFixture(supportsVision = true) {
  const f = await ingressFixture('open');
  f.sql.prepare(`INSERT INTO slack_conversation_files VALUES ('P','slack:T:C:1.0','F','pic.png','image/png',68,0,0)`).run();
  const admissions: any[] = [];
  const exported: Record<string, any> = {};
  const output = ts.transpileModule(readFileSync(new URL('./dispatch.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modules = new Map<string, unknown>();
  for (const match of output.matchAll(/require\("([^"]+)"\)/g)) {
    const name = match[1];
    if (name === '@flue/runtime' || name === '../agent/project') continue;
    const module = await import(new URL(`${name}.ts`, import.meta.url).href);
    modules.set(name, name === '../project/bindings' ? { ...module, modelSupportsVision: () => supportsVision } : module);
  }
  runInNewContext(output, { exports: exported, TextEncoder, Buffer,
    require: (name: string) => name === '@flue/runtime' ? { dispatch: async (_agent: unknown, request: unknown) => {
      admissions.push(request); return { submissionId: 'local', uid: 'local' };
    } } : name === '../agent/project' ? { Project() {} } : modules.get(name),
  });
  const files = [{ id: 'F', name: 'pic.png', mimetype: 'image/png', size: 68 }];
  const request: ProjectDispatchRequest = { id: agentInstanceId('P', 'conv:slack:T:C:1.0'), eventId: 'E',
    input: { message: '', conversationId: 'slack:T:C:1.0', attachedFiles: files },
    ...({ imageFiles: files } as object) };
  return { ...f, admissions, request, dispatch: (request: ProjectDispatchRequest) => exported.dispatchProject(f.env, request) };
}

const { test, run } = createTestRunner();
const signal = (input: Record<string, unknown>, snapshot: unknown = {}, eventId?: string) =>
  projectDispatchMessage(agentInstanceId('P'), input, snapshot as import('../agent/context').ProjectContext, eventId) as { kind: string; type: string; body: string; attributes: Record<string, string> };

test('preserves every dispatch family as native signal JSON and trusted input', () => {
  const inputs = [
    { message: 'hello', conversationId: 'slack:T:C:1', senderId: 'U', ackMessageTs: '2', threadContext: 'backscroll', attachedFiles: [{ id: 'F' }] },
    { kind: 'heartbeat', now: '2026-10-01', skill: 'reminder', instructions: 'scheduled work' },
    { kind: 'heartbeat', now: '2026-10-01', instructions: 'reflect and consolidate' },
    { kind: 'heartbeat', now: '2026-10-01', instructions: 'review ambient messages' },
    { kind: 'work_item', workItemId: 'W', title: 'Investigate', body: 'details' },
  ];
  const snapshot = { binding: { projectId: 'P' }, persona: { name: 'Local' } };
  for (const input of inputs) {
    const message = signal(input, snapshot);
    assert.equal(message.kind, 'signal');
    assert.equal(message.type, 'morehands.input');
    assert.deepEqual(JSON.parse(message.body), input);
    assert.deepEqual(JSON.parse(message.attributes.input), input);
    assert.deepEqual(JSON.parse(message.attributes.snapshot), snapshot);
    assert.equal(message.attributes.engaged, 'message' in input ? 'true' : 'false');
  }
});

test('only direct user input engages; reminders, overhear, reflection and review stay quiet', () => {
  assert.equal(signal({ message: 'hello' }).attributes.engaged, 'true');
  for (const family of ['scheduled', 'overhear', 'reflect', 'review']) {
    assert.equal(signal({ kind: 'heartbeat', message: 'background context', instructions: family }).attributes.engaged, 'false');
  }
});

test('nested untrusted attributes cannot replace trusted context or destination', () => {
  const input = { snapshot: { binding: { projectId: 'OTHER' } }, attributes: { admin: 'true', conversationId: 'OTHER' }, conversationId: 'slack:T:C:1', ackMessageTs: '2' };
  const message = signal(input, { binding: { projectId: 'P' } });
  assert.equal(message.attributes.snapshot, JSON.stringify({ binding: { projectId: 'P' } }));
  assert.equal(message.attributes.conversationId, 'slack:T:C:1');
  assert.equal(message.attributes.ackMessageTs, '2');
  assert.equal(message.attributes.admin, undefined);
});

test('durable tracker correlation comes from gateway metadata, not input attributes', () => {
  const message = signal({ eventId: 'spoofed', attributes: { eventId: 'spoofed' } }, {}, 'verified-event');
  assert.equal(message.attributes.eventId, 'verified-event');
});

test('native instance IDs partition destinations, epochs and quiet dispatch families', () => {
  const scopes = [
    conversationScope('slack:T:C:1', 0), conversationScope('slack:T:C:2', 0),
    conversationScope('slack:T:C:1', 1), conversationScope('slack:T:D:1', 0),
    'job:J', 'reflect:1', 'review:1', 'overhear:1', 'work:W',
  ];
  const ids = scopes.flatMap((scope) => ['P', 'Q'].map((project) => agentInstanceId(project, scope)));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(agentInstanceId('P', scopes[0]), agentInstanceId('P', conversationScope('slack:T:C:1', 0)));
});

test('text-only catalog capability prevents all media network and preserves handles with a notice', async () => {
  const f = await gatewayFixture(false);
  try {
    await f.dispatch(f.request);
    assert.ok(!f.effects.some(effect => effect.includes('files.info') || effect.includes('files-pri')));
    const message = f.admissions[0].message;
    assert.equal(message.kind, 'signal');
    const input = JSON.parse(message.body);
    assert.equal(input.attachedFiles[0].id, 'F');
    assert.equal(input.mediaCapabilityNotice, 'selected model does not accept images');
  } finally { f.dispose(); }
});
test('flash gateway prepares attachment-only input into one validated native user envelope', async () => {
  const f = await gatewayFixture();
  try {
    await f.dispatch(f.request);
    assert.equal(f.admissions.length, 1);
    const { message, initialData } = f.admissions[0];
    assert.equal(message.kind, 'user');
    assert.equal(message.attachments.length, 1);
    const envelope = JSON.parse(message.body);
    assert.equal(envelope.input.message, '');
    assert.deepEqual(envelope.trusted.snapshot, JSON.parse(JSON.stringify(initialData)));
    assert.ok(!JSON.stringify(message).includes('test-slack-token'));
  } finally { f.dispose(); }
});
test('gateway admits image input with a real nonempty Nango inventory', async () => {
  const f = await gatewayFixture();
  const slackFetch = globalThis.fetch;
  const env = f.env as typeof f.env & { NANGO_SECRET_KEY?: string };
  env.NANGO_SECRET_KEY = 'local-review-inventory';
  globalThis.fetch = (async (url, init) => String(url) === 'https://api.nango.dev/integrations'
    ? Response.json([{ unique_key: 'github', provider: 'github', display_name: 'GitHub' }])
    : slackFetch(url, init)) as typeof fetch;
  try {
    await f.dispatch(f.request);
    assert.equal(f.admissions.length, 1);
    const envelope = JSON.parse(f.admissions[0].message.body);
    assert.deepEqual(envelope.trusted.snapshot.connections.enabledIntegrations,
      [{ uniqueKey: 'github', provider: 'github', displayName: 'GitHub' }]);
  } finally { f.dispose(); }
});
test('media failure still admits text with a safe omission and no private error', async () => {
  const f = await gatewayFixture();
  try {
    f.setPrivateBody(Buffer.from('<html>private</html>'));
    await f.dispatch(f.request);
    const message = f.admissions[0].message;
    assert.equal(message.kind, 'signal');
    assert.deepEqual(JSON.parse(message.body).mediaNotices, [{ fileId: 'F', reason: 'invalid-header' }]);
    assert.ok(!message.body.includes('private</html>'));
  } finally { f.dispose(); }
});
test('whole-request size drops the lowest-priority image and retains its handle and omission', async () => {
  const f = await gatewayFixture();
  try {
    f.sql.prepare(`INSERT INTO slack_conversation_files VALUES ('P','slack:T:C:1.0','G','second.png','image/png',4000000,0,0)`).run();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
    const bytes = Buffer.alloc(4_000_000); png.copy(bytes); f.setPrivateBody(bytes);
    const files = [...f.request.imageFiles!, { id: 'G', name: 'second.png', mimetype: 'image/png', size: 4_000_000 }];
    await f.dispatch({ ...f.request, imageFiles: files, input: { ...f.request.input, message: 'x'.repeat(900_000), attachedFiles: files } });
    const message = f.admissions[0].message;
    assert.equal(message.attachments.length, 1);
    assert.equal(message.attachments[0].filename, 'pic.png');
    const input = JSON.parse(message.body).input;
    assert.equal(input.attachedFiles[1].id, 'G');
    assert.deepEqual(input.mediaNotices, [{ fileId: 'G', reason: 'native-payload-limit' }]);
    assert.ok(Buffer.byteLength(JSON.stringify(f.admissions[0])) < 11_500_000);
  } finally { f.dispose(); }
});
test('oversized text rejects before native dispatch without truncating trusted context', async () => {
  const f = await gatewayFixture();
  try {
    await assert.rejects(f.dispatch({ ...f.request, imageFiles: [], input: { ...f.request.input, message: 'x'.repeat(6_000_000) } }), /native payload limit/);
    assert.equal(f.admissions.length, 0);
  } finally { f.dispose(); }
});
test('invalid conversation rejects before any credential-bearing media request', async () => {
  const f = await gatewayFixture();
  try {
    await assert.rejects(f.dispatch({ ...f.request, input: { ...f.request.input, conversationId: 'slack:T:OTHER:1.0' } }), /Invalid project delivery/);
    assert.equal(f.admissions.length, 0);
    assert.ok(!f.effects.some(effect => effect.includes('files.info')));
  } finally { f.dispose(); }
});
test('durable preparation keeps confirmed absence and conflicting route as explicit rejections', async () => {
  const f = await gatewayFixture();
  try {
    const context = await loadProjectContext(f.env, f.request.id);
    assert.ok(context.binding);
    const route = { ...frozenRoute, instanceId: f.request.id, binding: context.binding, persona: null };
    await assert.rejects(prepareProjectDispatch(f.env, f.request, {
      expectedRoute: { ...route, binding: { ...context.binding, externalSpaceId: 'OTHER' } },
    }), (error: unknown) => error instanceof ProjectAdmissionError && /conflicts/.test(error.message));
    f.sql.exec("DELETE FROM bindings WHERE project_id='P'");
    await assert.rejects(prepareProjectDispatch(f.env, f.request, { expectedRoute: route }),
      (error: unknown) => error instanceof ProjectAdmissionError && /No active/.test(error.message));
    assert.equal(f.admissions.length, 0);
  } finally { f.dispose(); }
});
await run();
