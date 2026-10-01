import assert from 'node:assert/strict';
import type { ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';

export async function invokeTool(tool: ToolDefinition, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<string> {
  const data = tool.input ? v.parse(tool.input, args) : undefined;
  const result = await tool.run({
    data,
    toolCallId: 'test-tool-call',
    log: { info() {}, warn() {}, error() {} },
    signal,
  });
  assert.ok(typeof result === 'string', `expected a string result from ${tool.name}`);
  return result;
}

export type TestFn = () => Promise<void> | void;

export function createTestRunner(): {
  test: (name: string, fn: TestFn) => void;
  run: () => Promise<void>;
} {
  const tests: { name: string; fn: TestFn }[] = [];

  const test = (name: string, fn: TestFn) => {
    tests.push({ name, fn });
  };

  const run = async () => {
    let pass = 0;
    let fail = 0;

    for (const { name, fn } of tests) {
      try {
        await fn();
        console.log(`  ✓ ${name}`);
        pass++;
      } catch (e) {
        console.log(`  ✗ ${name}\n    ${(e as Error).message}`);
        fail++;
      }
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exit(1);
  };

  return { test, run };
}
