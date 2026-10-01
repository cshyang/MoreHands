import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createTestRunner } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';
import { reconcileReplies, reconcileNativeReplies } from './replies';

const { test, run } = createTestRunner();
function fixture(count: number) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../../migrations/0030_slack_reply_trackers.sql', import.meta.url), 'utf8'));
  for (let index = 0; index < count; index++) sql.prepare(`INSERT INTO slack_reply_trackers
    (instance_id,event_id,target_json,publish,created_at,updated_at) VALUES (?,?,?,1,1,1)`)
    .run(`instance-${String(index).padStart(2, '0')}`, `event-${index}`, '{}');
  const db: D1Like = { prepare: (query) => ({ bind: (...values) => ({
    run: async () => sql.prepare(query).run(...values as never[]),
    first: async <T>() => (sql.prepare(query).get(...values as never[]) ?? null) as T | null,
    all: async <T>() => ({ results: sql.prepare(query).all(...values as never[]) as T[] }),
  }) }) };
  return { sql, db };
}

test('bounded replay rotates failed instances fairly and still sweeps delivery', async () => {
  const f = fixture(12);
  const visited: string[] = [];
  let delivery = 0;
  let finalization = 0;
  const deps = {
    reconcileInstance: async (id: string) => { visited.push(id); throw new Error('native unavailable'); },
    deliver: async () => { delivery++; }, finalize: async () => { finalization++; }, log: () => {},
  };
  const first = await reconcileReplies(f.db, {}, { ...deps, now: 2 });
  assert.equal(first.instances, 10);
  assert.equal(first.replayFailures, 10);
  await reconcileReplies(f.db, {}, { ...deps, now: 3 });
  assert.equal(new Set(visited).size, 12);
  assert.equal(delivery, 2);
  assert.equal(finalization, 2);
});

test('failed terminal receipt instances rotate rather than starving unprocessed admissions', async () => {
  const f = fixture(12);
  f.sql.exec("UPDATE slack_reply_trackers SET status='failed' WHERE instance_id<'instance-10'");
  const visited: string[] = [];
  const deps = { reconcileInstance: async (id: string) => { visited.push(id); throw new Error('unavailable'); },
    deliver: async () => {}, finalize: async () => {}, log: () => {} };
  await reconcileReplies(f.db, {}, { ...deps, now: 2 });
  await reconcileReplies(f.db, {}, { ...deps, now: 3 });
  assert.equal(new Set(visited).size, 12);
});

test('native timeout and outbox failure cannot suppress finalization', async () => {
  const f = fixture(1);
  let finalized = false;
  const summary = await reconcileReplies(f.db, {}, {
    reconcileInstance: () => new Promise(() => {}), timeoutMs: 1,
    deliver: async () => { throw new Error('outbox unavailable'); },
    finalize: async () => { finalized = true; }, log: () => {},
  });
  assert.equal(summary.replayFailures, 1);
  assert.equal(summary.deliveryFailed, true);
  assert.equal(summary.finalizationFailed, false);
  assert.equal(finalized, true);
});

test('enumeration failure still runs both delivery recovery phases', async () => {
  const f = fixture(0);
  f.sql.exec('DROP TABLE slack_reply_trackers');
  const calls: string[] = [];
  const summary = await reconcileReplies(f.db, {}, {
    reconcileInstance: async () => { calls.push('native'); },
    deliver: async () => { calls.push('deliver'); }, finalize: async () => { calls.push('finalize'); }, log: () => {},
  });
  assert.deepEqual(calls, ['deliver', 'finalize']);
  assert.equal(summary.replayFailures, 1);
});

test('native lookup initializes the exact named DO before custom reconciliation RPC', async () => {
  const calls: string[] = [];
  const id = {} as DurableObjectId;
  await reconcileNativeReplies({
    idFromName: (name) => { calls.push(`lookup:${name}`); return id; },
    get: (value) => {
      assert.equal(value, id);
      return { setName: async (name) => { calls.push(`start:${name}`); },
        reconcileReplies: async () => { calls.push('reconcile'); return []; } };
    },
  }, 'project:P/conv:C');
  assert.deepEqual(calls, ['lookup:project:P/conv:C', 'start:project:P/conv:C', 'reconcile']);
  await assert.rejects(reconcileNativeReplies(undefined, 'i'), /Missing native/);
});

await run();
