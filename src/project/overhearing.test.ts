// set_overhearing tool invariants — run: npx tsx src/project/overhearing.test.ts

import assert from 'node:assert/strict';
import { createTestRunner, invokeTool } from '../shared/test-utils';
import { overhearingTools } from './overhearing';
import type { D1Like } from '../skills/repository';

const { test, run } = createTestRunner();

// Minimal fake capturing the one UPDATE setBindingOverhear issues.
class FakeD1 implements D1Like {
  updates: Array<{ overhear: unknown; projectId: unknown }> = [];
  prepare(sql: string) {
    return {
      bind: (...a: unknown[]) => ({
        run: async () => {
          if (sql.trim().startsWith('UPDATE bindings SET overhear')) this.updates.push({ overhear: a[0], projectId: a[2] });
          return {};
        },
        all: async () => ({ results: [] }),
        first: async () => null,
      }),
    } as unknown as ReturnType<D1Like['prepare']>;
  }
}

test('overhearingTools: gated off without a db', () => {
  assert.equal(overhearingTools(undefined, 'P1').length, 0);
});

test('set_overhearing enabled=true writes overhear=1 for this project and confirms ON', async () => {
  const db = new FakeD1();
  const [tool] = overhearingTools(db, 'C_OH');
  const out = await invokeTool(tool, { enabled: true });
  assert.deepEqual(db.updates, [{ overhear: 1, projectId: 'C_OH' }]);
  assert.match(String(out), /ON for this channel/);
});

test('set_overhearing enabled=false writes overhear=0 and confirms OFF', async () => {
  const db = new FakeD1();
  const [tool] = overhearingTools(db, 'C_OH');
  const out = await invokeTool(tool, { enabled: false });
  assert.deepEqual(db.updates, [{ overhear: 0, projectId: 'C_OH' }]);
  assert.match(String(out), /OFF for this channel/);
});

test('set_overhearing input rejects non-booleans before changing the binding', async () => {
  const db = new FakeD1();
  const [tool] = overhearingTools(db, 'C_OH');
  await assert.rejects(invokeTool(tool, { enabled: 'true' }), /boolean/i);
  assert.deepEqual(db.updates, []);
});

await run();
