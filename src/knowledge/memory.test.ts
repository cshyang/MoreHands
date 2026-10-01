// Memory invariants — run: npm test  (npx tsx src/knowledge/memory.test.ts)
//
// Exercises knowledge/memory.ts against an in-memory D1 fake (no workers runtime needed). v1 memory
// is project-scoped; project ISOLATION is the load-bearing security invariant, not ceremony.

import assert from 'node:assert/strict';
import { createTestRunner, invokeTool } from '../shared/test-utils';
import { memoryTools, loadProjectMemory, PROJECT_LIMIT, PER_ENTRY_MAX } from './memory';
import type { D1Like } from '../skills/repository';

interface Row {
  id: number;
  project_id: string;
  scope: string;
  subject: string;
  fact: string;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
}

// Minimal D1 fake: stores rows, interprets the handful of fixed queries in memory.ts.
class FakeD1 implements D1Like {
  rows: Row[] = [];
  private nextId = 1;

  prepare(query: string) {
    const db = this;
    return {
      bind(...values: unknown[]) {
        return {
          async run(): Promise<unknown> {
            db.exec(query, values);
            return {};
          },
          async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
            return { results: db.select(query, values) as T[] };
          },
          async first<T = Record<string, unknown>>(): Promise<T | null> {
            return (db.select(query, values)[0] ?? null) as T | null;
          },
        };
      },
    };
  }

  private select(q: string, v: unknown[]): Record<string, unknown>[] {
    if (q.includes("scope='project'")) {
      const [pid] = v;
      return this.rows.filter((r) => r.project_id === pid && r.scope === 'project').map((r) => ({ id: r.id, fact: r.fact }));
    }
    if (q.includes('SELECT id FROM memories')) {
      const [pid, id] = v;
      return this.rows.filter((r) => r.project_id === pid && r.id === id).map((r) => ({ id: r.id }));
    }
    return [];
  }

  private exec(q: string, v: unknown[]): void {
    if (q.startsWith('INSERT')) {
      const [project_id, scope, subject, fact, created_by, updated_by, created_at, updated_at] = v as [
        string, string, string, string, string, string, number, number,
      ];
      this.rows.push({ id: this.nextId++, project_id, scope, subject, fact, created_by, updated_by, created_at, updated_at });
    } else if (q.startsWith('UPDATE')) {
      const [fact, updated_by, updated_at, pid, id] = v as [string, string, number, string, number];
      const row = this.rows.find((r) => r.project_id === pid && r.id === id);
      if (row) Object.assign(row, { fact, updated_by, updated_at });
    } else if (q.startsWith('DELETE')) {
      const [pid, id] = v as [string, number];
      this.rows = this.rows.filter((r) => !(r.project_id === pid && r.id === id));
    }
  }
}

type Tool = ReturnType<typeof memoryTools>[number];
const byName = (tools: Tool[], name: string): Tool => {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t;
};

const { test, run } = createTestRunner();

test('project isolation: a project-A fact is invisible to project B', async () => {
  const db = new FakeD1();
  await invokeTool(byName(memoryTools(db, 'A'), 'save_memory'), { fact: 'A ships weekly' });
  assert.equal((await loadProjectMemory(db, 'A')).length, 1);
  assert.equal((await loadProjectMemory(db, 'B')).length, 0);
});

test('full-budget refusal: over-limit save is refused, not inserted', async () => {
  const db = new FakeD1();
  const save = byName(memoryTools(db, 'A'), 'save_memory');
  // ~588 rendered each; fill to one entry below the budget, then the next overflows.
  const fitting = Math.floor(PROJECT_LIMIT / 588);
  const big = (i: number) => 'x'.repeat(580) + i;
  for (let i = 0; i < fitting; i++) assert.match(await invokeTool(save, { fact: big(i) }), /^Remembered:/);
  const refused = await invokeTool(save, { fact: big(99) });
  assert.match(refused, /full/i);
  assert.equal((await loadProjectMemory(db, 'A')).length, fitting, 'no overflowing row inserted');
  assert.equal(PROJECT_LIMIT, 6000); // sized for a 10-20 person team channel
});

test('duplicate rejection: identical fact saved once', async () => {
  const db = new FakeD1();
  const save = byName(memoryTools(db, 'A'), 'save_memory');
  assert.equal(await invokeTool(save, { fact: 'same fact' }), 'Remembered: same fact');
  assert.match(await invokeTool(save, { fact: 'same fact' }), /[Aa]lready/);
  assert.equal((await loadProjectMemory(db, 'A')).length, 1);
});

test('id-scoped update/forget, and a cross-project id cannot touch another project', async () => {
  const db = new FakeD1();
  await invokeTool(byName(memoryTools(db, 'A'), 'save_memory'), { fact: 'original' });
  const id = (await loadProjectMemory(db, 'A'))[0].id;

  // project B trying to update/forget A's id is rejected / no-op
  await assert.rejects(invokeTool(byName(memoryTools(db, 'B'), 'update_memory'), { id, fact: 'hijacked' }), /No memory/);
  await invokeTool(byName(memoryTools(db, 'B'), 'forget_memory'), { id });
  assert.equal((await loadProjectMemory(db, 'A'))[0].fact, 'original', 'A row survived B-scoped ops');

  // A can update + forget its own id
  assert.equal(await invokeTool(byName(memoryTools(db, 'A'), 'update_memory'), { id, fact: 'revised' }), 'Memory updated: revised');
  assert.equal((await loadProjectMemory(db, 'A'))[0].fact, 'revised');
  await invokeTool(byName(memoryTools(db, 'A'), 'forget_memory'), { id });
  assert.equal((await loadProjectMemory(db, 'A')).length, 0);
});

test('per-entry cap: an essay is refused', async () => {
  const db = new FakeD1();
  await assert.rejects(
    invokeTool(byName(memoryTools(db, 'A'), 'save_memory'), { fact: 'y'.repeat(PER_ENTRY_MAX + 1) }),
    /≤|chars/,
  );
});

test('memory tool inputs require integer ids and strings before accessing the database', async () => {
  const db = new FakeD1();
  await assert.rejects(invokeTool(byName(memoryTools(db, 'A'), 'update_memory'), { id: 1.5, fact: 'invalid' }), /integer/i);
  await assert.rejects(invokeTool(byName(memoryTools(db, 'A'), 'forget_memory'), { id: '1' }), /number/i);
  await assert.rejects(invokeTool(byName(memoryTools(db, 'A'), 'save_memory'), { fact: 42 }), /string/i);
  assert.equal(db.rows.length, 0);
});

await run();
