// Project-agent prompt setup guidance invariants — run: npx tsx src/agent/prompt.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { buildInstructions } from './prompt';

const { test, run } = createTestRunner();

test('Slack setup prompt tells the agent to call setup_status before request_connection', async () => {
  const prompt = buildInstructions({
    projectName: 'project_1',
    personality: null,
    catalog: [],
    connectionsBlock: 'YOUR CONNECTIONS\n  ⚪ github (not connected)\n  ⚪ linear (not connected)\ncall request_connection',
  });

  assert.match(prompt, /setup_status/i);
  assert.match(prompt, /request_connection/i);
  assert.ok(
    prompt.indexOf('setup_status') < prompt.indexOf('request_connection'),
    'setup_status guidance must appear before request_connection guidance',
  );
});

test('prompt allows a few meaningful status updates but rejects raw tool traces', async () => {
  const prompt = buildInstructions({
    projectName: 'project_1',
    personality: null,
    catalog: [],
  });

  assert.match(prompt, /up to 3 meaningful phase updates/i);
  assert.match(prompt, /Checking the repo/i);
  assert.match(prompt, /do not list raw tool names/i);
  assert.match(prompt, /Automatic activity receipts/i);
  assert.match(prompt, /do not duplicate automatic tool activity/i);
});

test('prompt tells the agent to include concise memory notices after memory changes', async () => {
  const prompt = buildInstructions({
    projectName: 'project_1',
    personality: null,
    catalog: [],
    memoryBlock: 'WHAT YOU REMEMBER\nMemory [1% — 20/2000]\n[1] This channel uses acme/widgets.',
  });

  assert.match(prompt, /Remembered:/);
  assert.match(prompt, /Memory updated:/);
  assert.match(prompt, /include a short memory notice/i);
});

test('prompt explains coordinator code mode and its limits', async () => {
  const prompt = buildInstructions({
    projectName: 'project_1',
    personality: null,
    catalog: [],
  });

  assert.match(prompt, /execute_code/);
  assert.match(prompt, /lightweight/i);
  assert.match(prompt, /JavaScript/i);
  assert.match(prompt, /Python/i);
  assert.match(prompt, /not bash/i);
  assert.match(prompt, /not a repo workspace/i);
  assert.match(prompt, /not source-code editing/i);
});

test('engaged replies end in plain final text, not the old mandatory reply tool', () => {
  const prompt = buildInstructions({ projectName: 'project_1', personality: null, catalog: [], engaged: true });
  assert.match(prompt, /complete plain final answer/);
  assert.match(prompt, /reply_to_conversation is unavailable/);
  assert.doesNotMatch(prompt, /FINAL action is ALWAYS|silently DISCARDED|End every turn by calling/);
});

test('autonomous no-op turns stay quiet and intentional posts retain their tool', () => {
  const prompt = buildInstructions({ projectName: 'project_1', personality: null, catalog: [], engaged: false });
  assert.match(prompt, /This is autonomous work/);
  assert.match(prompt, /Otherwise stay quiet/);
  assert.match(prompt, /through reply_to_conversation/);
});

await run();
