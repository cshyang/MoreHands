import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { ensureNativeModelAuth } from './providers';

const { test, run } = createTestRunner();

function withOriginalKey(action: () => void): void {
  const original = process.env.ZAI_API_KEY;
  try { action(); } finally {
    if (original === undefined) delete process.env.ZAI_API_KEY;
    else process.env.ZAI_API_KEY = original;
  }
}

test('legacy deployment secret feeds native Z.ai auth in the isolate', () => withOriginalKey(() => {
  delete process.env.ZAI_API_KEY;
  ensureNativeModelAuth({ ZAI_CODING_API_KEY: 'legacy-key' });
  assert.equal(process.env.ZAI_API_KEY, 'legacy-key');
}));

test('explicit native Worker binding wins over legacy and stale process alias', () => withOriginalKey(() => {
  process.env.ZAI_API_KEY = 'stale-key';
  ensureNativeModelAuth({ ZAI_API_KEY: 'native-key', ZAI_CODING_API_KEY: 'legacy-key' });
  assert.equal(process.env.ZAI_API_KEY, 'native-key');
}));

test('current bindings replace prior aliases and absent secrets clear stale auth', () => withOriginalKey(() => {
  ensureNativeModelAuth({ ZAI_CODING_API_KEY: 'first-key' });
  ensureNativeModelAuth({ ZAI_CODING_API_KEY: 'second-key' });
  assert.equal(process.env.ZAI_API_KEY, 'second-key');
  ensureNativeModelAuth({ ZAI_API_KEY: 42 });
  assert.equal(process.env.ZAI_API_KEY, undefined);
}));

await run();
