import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { loadProjectContext, projectContextForDelivery, parseProjectDispatchInput, isEngagedProjectInput } from './context';
import { projectDispatchMessage } from '../gateway/dispatch-message';
import { agentInstanceId } from '../project/bindings';
import { connectionRuntimeFromSnapshot } from '../connections/runtime';
import type { D1Like } from '../skills/repository';

const { test, run } = createTestRunner();

test('gateway signal body preserves engaged input for trusted thread and acknowledgement parsing', () => {
  const input = { message: 'hello', conversationId: 'slack:T:C:1', ackMessageTs: '1.2' };
  const delivery = projectDispatchMessage(agentInstanceId('P'), input, {} as import('./context').ProjectContext);
  assert.notEqual(typeof delivery, 'string');
  assert.deepEqual(parseProjectDispatchInput((delivery as { body: string }).body), input);
  assert.deepEqual(parseProjectDispatchInput(JSON.stringify(input)), input);
  assert.equal(parseProjectDispatchInput(`[Dispatch Input]\ninput: ${JSON.stringify(input)}`), null, 'legacy dispatch envelopes are no longer admitted');
});

test('trusted engaged false remains authoritative even when body contains a message', () => {
  assert.equal(isEngagedProjectInput({ engaged: 'false' }, { message: 'ambient message' }), false);
  assert.equal(isEngagedProjectInput({ engaged: 'true' }, null), true);
  assert.equal(isEngagedProjectInput(undefined, { kind: 'heartbeat', message: 'scheduled context' }), false);
  assert.equal(isEngagedProjectInput(undefined, { message: 'user message' }), true);
});

test('gateway snapshot is serializable metadata, never env credentials or tool functions', async () => {
  const context = await loadProjectContext({ GITHUB_PAT_ECODARK: 'secret-github', SLACK_BOT_TOKEN_DEFAULT: 'secret-slack', ZAI_CODING_API_KEY: 'secret-model' }, agentInstanceId('demo'));
  assert.equal(context.binding?.projectId, 'demo');
  assert.equal(context.connections.specs[0].tokenRef, 'GITHUB_PAT_ECODARK');
  const json = JSON.stringify(context);
  assert.doesNotMatch(json, /secret-github|secret-slack|secret-model/);
  assert.deepEqual(JSON.parse(json), context);
  assert.equal('tools' in context.connections, false);
  assert.equal('env' in context, false);
});

test('fresh delivered snapshot overrides creation data before the first render', async () => {
  const id = agentInstanceId('demo');
  const initial = await loadProjectContext({}, id);
  const current = { ...initial, personality: 'fresh personality', binding: { ...initial.binding!, model: 'zai/glm-5.3-flash' } };
  assert.deepEqual(projectContextForDelivery(id, JSON.stringify(current), initial), current);
  assert.equal(projectContextForDelivery(id, undefined, initial), initial);
  assert.equal(projectContextForDelivery(id, '{', initial), null, 'malformed delivery must not fall back to stale creation data');
  assert.equal(projectContextForDelivery(agentInstanceId('other'), undefined, initial), null);
  assert.equal(projectContextForDelivery(id, JSON.stringify({ ...current, binding: { ...current.binding, projectId: 'other' } }), initial), null);
  assert.equal(projectContextForDelivery(id, JSON.stringify({ projectId: 'demo', slug: 'default' }), initial), null);
});

test('D1 snapshot carries persona, stripped personality, filtered catalog and bounded project memory', async () => {
  const db: D1Like = {
    prepare(sql) {
      return { bind: () => ({
        run: async () => ({}),
        first: async <T>() => (sql.includes('FROM personas') ? { name: 'Owl', icon_emoji: ':owl:', icon_url: null } : null) as T | null,
        all: async <T>() => {
          let rows: unknown[] = [];
          if (sql.includes('SELECT name, description, project_id FROM skills')) rows = [
            { name: 'personality', description: 'voice', project_id: 'demo' },
            { name: 'soul-owl', description: 'template', project_id: '__global__' },
            { name: 'research', description: 'Research topics', project_id: 'demo' },
          ];
          else if (sql.includes('SELECT body_md, project_id FROM skills')) rows = [{ body_md: '---\nname: personality\n---\nBe direct.', project_id: 'demo' }];
          else if (sql.includes('FROM memories')) rows = [{ id: 1, fact: 'Use acme/widgets.' }];
          return { results: rows as T[] };
        },
      }) };
    },
  };
  const context = await loadProjectContext({ DB: db }, agentInstanceId('demo'));
  assert.equal(context.persona?.name, 'Owl');
  assert.equal(context.personality, 'Be direct.');
  assert.deepEqual(context.catalog, [{ name: 'research', description: 'Research topics' }]);
  assert.match(context.memoryBlock!, /Use acme\/widgets/);
  assert.deepEqual(JSON.parse(JSON.stringify(context)), context);
});

test('unbound project snapshot is inert', async () => {
  const context = await loadProjectContext({}, agentInstanceId('missing'));
  assert.equal(context.binding, null);
  assert.deepEqual(context.connections, { specs: [], enabledIntegrations: [] });
});

test('connection tools assemble synchronously from specs and live isolate secrets', async () => {
  const context = await loadProjectContext({}, agentInstanceId('demo'));
  const unavailable = connectionRuntimeFromSnapshot({ db: undefined, env: {}, projectId: 'demo', snapshot: context.connections });
  assert.equal(unavailable.tools.some((tool) => tool.name === 'github_call_api'), false);
  const available = connectionRuntimeFromSnapshot({ db: undefined, env: { GITHUB_PAT_ECODARK: 'live-key' }, projectId: 'demo', snapshot: context.connections });
  assert.equal(available.tools.some((tool) => tool.name === 'github_call_api'), true);
  assert.doesNotMatch(JSON.stringify(context), /live-key/);
});

await run();
