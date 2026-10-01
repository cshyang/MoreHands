import assert from 'node:assert/strict';
import type { ToolDefinition } from '@flue/runtime';
import { createTestRunner, invokeTool } from '../shared/test-utils';
import { buildSelfStatus, selfStatusTool } from './self';

const { test, run } = createTestRunner();

const invoke = (tool: ToolDefinition) =>
  invokeTool(tool, {});

test('buildSelfStatus reports the live runtime manifest without exposing connection config values', () => {
  const status = buildSelfStatus({
    projectId: 'C_PROJECT',
    agentSlug: 'default',
    model: 'gpt-test',
    hasDb: true,
    hasBotToken: true,
    canRequestConnections: true,
    hasCodingRunner: true,
    hasAgentRunner: true,
    hasLinearAgentIngress: true,
    hasCodeMode: true,
    codeModeLimits: { maxCodeBytes: 20_000, maxInputBytes: 100_000, maxOutputBytes: 20_000, cpuMs: 5000, subRequests: 50 },
    hasWorkspace: true,
    workspaceLimits: { execTimeoutMs: 60_000, maxExecTimeoutMs: 300_000, maxOutputBytes: 20_000, maxReadBytes: 1_000_000, maxWriteBytes: 1_000_000 },
    providerCatalog: [
      { provider: 'github', summary: 'read repos' },
      { provider: 'notion', summary: 'read docs' },
    ],
    connectionState: [
      { provider: 'github', status: 'connected', config: { repo: 'owner/private-repo' } },
      { provider: 'notion', status: 'not_connected', config: {} },
    ],
    connectionToolNames: ['github_call_api', 'request_connection'],
  });

  assert.deepEqual(status.identity, { projectId: 'C_PROJECT', agentSlug: 'default' });
  assert.deepEqual(status.runtime, {
    harness: 'flue',
    substrate: 'cloudflare_durable_object',
    model: 'gpt-test',
  });
  assert.equal(status.capabilities.reply.enabled, true);
  assert.deepEqual(status.capabilities.reply.tools, []);
  assert.match(status.capabilities.reply.note, /Plain final text is delivered automatically/);
  assert.doesNotMatch(status.capabilities.reply.note, /discarded/);
  assert.equal(status.capabilities.status.enabled, true);
  assert.deepEqual(status.capabilities.status.tools, ['update_status']);
  assert.equal(status.capabilities.skills.enabled, true);
  // Reminders are gated on DB only since the D1 store replaced the ticker's SchedulerDO.
  assert.equal(status.capabilities.reminders.enabled, true);
  assert.equal(status.capabilities.sourceEvolution.enabled, true);
  assert.deepEqual(status.capabilities.sourceEvolution.tools, ['propose_self_change', 'dispatch_coding_run']);
  assert.equal(status.capabilities.agentRuns.enabled, true);
  assert.deepEqual(status.capabilities.agentRuns.tools, ['propose_agent_route']);
  assert.match(status.capabilities.agentRuns.note, /Linear/);
  assert.match(status.capabilities.agentRuns.note, /Trigger\.dev/);
  assert.match(status.capabilities.agentRuns.note, /Pi/);
  assert.match(status.capabilities.agentRuns.note, /Agent Kits/);
  assert.match(status.capabilities.agentRuns.note, /admin-only/);
  assert.equal(status.capabilities.codeMode.enabled, true);
  assert.deepEqual(status.capabilities.codeMode.tools, ['execute_code']);
  assert.match(status.capabilities.codeMode.note, /JavaScript/);
  assert.match(status.capabilities.codeMode.note, /Python/);
  assert.match(status.capabilities.codeMode.note, /public network/);
  assert.equal(status.capabilities.workspace.enabled, true);
  assert.deepEqual(status.capabilities.workspace.tools, [
    'workspace_exec',
    'workspace_write_file',
    'workspace_read_file',
    'workspace_load_slack_file',
    'workspace_send_file',
  ]);
  assert.match(status.capabilities.workspace.note, /EPHEMERAL/);
  assert.match(status.capabilities.workspace.note, /pandas/);
  assert.match(status.capabilities.workspace.note, /distinct from Code Mode/i);
  assert.match(status.capabilities.workspace.note, /No MoreHands secrets/);
  assert.equal(JSON.stringify(status).includes('NANGO_SECRET_KEY'), false);
  assert.equal(JSON.stringify(status).includes('OpenCode'), false);
  assert.equal(JSON.stringify(status).includes('Claude Code'), false);
  assert.match(status.limits.join('\n'), /E2B/);
  assert.match(status.capabilities.reminders.note, /D1/);
  assert.deepEqual(status.connections.providers, [
    { provider: 'github', status: 'connected', configKeys: ['repo'] },
    { provider: 'notion', status: 'not_connected', configKeys: [] },
  ]);
  assert.deepEqual(status.connections.requestableProviders, ['github', 'notion']);
  assert.deepEqual(status.connections.toolNames, ['github_call_api', 'request_connection']);
  assert.equal(JSON.stringify(status).includes('owner/private-repo'), false);
  // With workspace enabled, the filesystem limit names the sandbox instead of denying outright.
  assert.ok(status.limits.some((line) => line.includes('no native filesystem') && line.includes('workspace sandbox')));
  assert.ok(status.limits.some((line) => line.includes('No raw environment access')));
});

test('self_status tool returns the manifest as formatted JSON', async () => {
  const tool = selfStatusTool({
    projectId: 'P',
    agentSlug: 'helper',
    engaged: false,
    model: 'gpt-test',
    hasDb: true,
    hasBotToken: false,
    canRequestConnections: false,
    hasCodingRunner: false,
    hasAgentRunner: false,
    hasLinearAgentIngress: true,
    hasCodeMode: false,
    codeModeLimits: null,
    hasWorkspace: false,
    workspaceLimits: null,
    providerCatalog: [],
    connectionState: [],
    connectionToolNames: [],
  });

  const parsed = JSON.parse(await invoke(tool));
  assert.equal(parsed.identity.projectId, 'P');
  assert.equal(parsed.capabilities.reply.enabled, true);
  assert.deepEqual(parsed.capabilities.reply.tools, ['reply_to_conversation']);
  assert.match(parsed.capabilities.reply.note, /Autonomous turns have no automatic reply destination/);
  assert.match(parsed.capabilities.reply.note, /explicit conversationId/);
  assert.equal(parsed.capabilities.status.enabled, false);
  assert.deepEqual(parsed.capabilities.status.tools, []);
  assert.equal(parsed.capabilities.memory.enabled, true);
  assert.equal(parsed.capabilities.reminders.enabled, true);
  assert.equal(parsed.capabilities.sourceEvolution.enabled, true);
  assert.deepEqual(parsed.capabilities.sourceEvolution.tools, ['propose_self_change']);
  assert.equal(parsed.capabilities.agentRuns.enabled, true);
  assert.match(parsed.capabilities.agentRuns.note, /not configured/);
  assert.match(parsed.capabilities.agentRuns.note, /Trigger\.dev/);
  assert.deepEqual(parsed.capabilities.agentRuns.tools, ['propose_agent_route']);
  assert.equal(parsed.capabilities.codeMode.enabled, false);
  assert.deepEqual(parsed.capabilities.codeMode.tools, []);
  assert.equal(parsed.capabilities.workspace.enabled, false);
  assert.deepEqual(parsed.capabilities.workspace.tools, []);
  assert.match(parsed.capabilities.workspace.note, /SANDBOX/);
  assert.ok(parsed.limits.some((line: string) => line.includes('no filesystem or shell access')));
});

run();
