// Skill lifecycle invariants — run: npm test
// The load-bearing ones: archived skills leave the catalog, are NOT loadable, and are REFUSED by
// scheduled fire (distinguishable from absent) — so an archived skill can never run stale on a
// schedule. Plus: archive is reversible, re-saving reactivates, provenance is stamped, projects
// are isolated, and there is no hard-delete tool.

import assert from 'node:assert/strict';
import { createTestRunner, invokeTool } from '../shared/test-utils';
import {
  loadSkillCatalog,
  loadActiveSkillBody,
  loadRunnableSkillBody,
  skillTools,
  type D1Like,
} from './repository';

interface SkillRow {
  project_id: string;
  name: string;
  description: string;
  body_md: string;
  state: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

// Minimal D1 fake covering the fixed queries in skills/repository.ts. Keyed by (project_id, name); UPDATEs
// report rowcount via { meta: { changes } } the way real D1 does (archive/restore read it).
class FakeD1 implements D1Like {
  rows: SkillRow[] = [];

  prepare(query: string) {
    const db = this;
    return {
      bind(...v: unknown[]) {
        return {
          async run(): Promise<unknown> {
            return db.exec(query, v);
          },
          async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
            return { results: db.select(query, v) as T[] };
          },
          async first<T = Record<string, unknown>>(): Promise<T | null> {
            return (db.select(query, v)[0] ?? null) as T | null;
          },
        };
      },
    };
  }

  private find(project_id: string, name: string): SkillRow | undefined {
    return this.rows.find((r) => r.project_id === project_id && r.name === name);
  }

  private select(q: string, v: unknown[]): Record<string, unknown>[] {
    // Global-merge catalog (faithful — returns ALL matching active rows; production does the dedup):
    // SELECT name, description, project_id WHERE project_id IN (?, ?) AND state='active'
    if (q.includes('SELECT name, description') && q.includes('IN (')) {
      const [pGlobal, pChannel] = v as [string, string];
      return this.rows
        .filter((x) => (x.project_id === pGlobal || x.project_id === pChannel) && x.state === 'active')
        .map((r) => ({ name: r.name, description: r.description, project_id: r.project_id }));
    }
    // loadRunnableSkillBody (global∪channel, any state): WHERE name=? AND project_id IN (?, ?)
    // MUST come before the active-merge body branch — discriminated by 'body_md, state' substring.
    if (q.includes('body_md, state') && q.includes('IN (')) {
      const [name, pGlobal, pChannel] = v as [string, string, string];
      const out: Record<string, unknown>[] = [];
      for (const r of this.rows.filter((x) => x.name === name && (x.project_id === pGlobal || x.project_id === pChannel))) {
        out.push({ body_md: r.body_md, state: r.state, project_id: r.project_id });
      }
      return out;
    }
    // Global-merge body (active-only): SELECT body_md, project_id WHERE name=? AND project_id IN (?, ?) AND state='active'
    if (q.includes('SELECT body_md') && q.includes('IN (')) {
      const [name, pGlobal, pChannel] = v as [string, string, string];
      const out: Record<string, unknown>[] = [];
      for (const r of this.rows.filter((x) => x.name === name && (x.project_id === pGlobal || x.project_id === pChannel) && x.state === 'active')) {
        out.push({ body_md: r.body_md, project_id: r.project_id });
      }
      return out;
    }
    if (q.includes('body_md, state')) {
      // legacy single-project shape (kept for safety): WHERE project_id=? AND name=?
      const row = this.find(v[0] as string, v[1] as string);
      return row ? [{ body_md: row.body_md, state: row.state }] : [];
    }
    if (q.includes('SELECT body_md')) {
      // loadActiveSkillBody: active only
      const row = this.find(v[0] as string, v[1] as string);
      return row && row.state === 'active' ? [{ body_md: row.body_md }] : [];
    }
    if (q.includes('SELECT name, description')) {
      // loadSkillCatalog: active only, sorted by name
      return this.rows
        .filter((r) => r.project_id === (v[0] as string) && r.state === 'active')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((r) => ({ name: r.name, description: r.description }));
    }
    return [];
  }

  private exec(q: string, v: unknown[]): { meta: { changes: number } } {
    if (q.startsWith('INSERT INTO skills')) {
      // bind: (projectId, name, description, md, created_at, updated_at)
      const [project_id, name, description, body_md, created_at, updated_at] = v as [
        string, string, string, string, number, number,
      ];
      const existing = this.find(project_id, name);
      if (existing) {
        existing.description = description;
        existing.body_md = body_md;
        existing.state = 'active';
        existing.updated_by = 'agent';
        existing.updated_at = updated_at;
        existing.archived_at = null;
        // created_at / created_by preserved (ON CONFLICT does not touch them)
        return { meta: { changes: 1 } };
      }
      this.rows.push({
        project_id, name, description, body_md, state: 'active',
        created_by: 'agent', updated_by: 'agent', created_at, updated_at, archived_at: null,
      });
      return { meta: { changes: 1 } };
    }
    if (q.includes("SET state='archived'")) {
      // bind: (archived_at, updated_at, projectId, name)
      const [archived_at, updated_at, project_id, name] = v as [number, number, string, string];
      const row = this.find(project_id, name);
      if (row && row.state === 'active') {
        row.state = 'archived';
        row.archived_at = archived_at;
        row.updated_by = 'agent';
        row.updated_at = updated_at;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (q.includes("SET state='active'")) {
      // restore — bind: (updated_at, projectId, name)
      const [updated_at, project_id, name] = v as [number, string, string];
      const row = this.find(project_id, name);
      if (row && row.state === 'archived') {
        row.state = 'active';
        row.archived_at = null;
        row.updated_by = 'agent';
        row.updated_at = updated_at;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    return { meta: { changes: 0 } };
  }
}

const mkmd = (name: string, body = 'Steps here.') =>
  `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n${body}`;

const invoke = (tools: ReturnType<typeof skillTools>, name: string, args: Record<string, unknown>) =>
  invokeTool(tools.find((t) => t.name === name)!, args);

const { test, run } = createTestRunner();

test('catalog hides archived skills', async () => {
  const db = new FakeD1();
  const t = skillTools(db, 'P');
  await invoke(t, 'save_skill', { skill_md: mkmd('alpha') });
  await invoke(t, 'save_skill', { skill_md: mkmd('beta') });
  assert.deepEqual((await loadSkillCatalog(db, 'P')).map((s) => s.name), ['alpha', 'beta']);
  await invoke(t, 'archive_skill', { name: 'beta' });
  assert.deepEqual((await loadSkillCatalog(db, 'P')).map((s) => s.name), ['alpha'], 'archived gone from catalog');
});

test('load_skill refuses an archived skill', async () => {
  const db = new FakeD1();
  const t = skillTools(db, 'P');
  await invoke(t, 'save_skill', { skill_md: mkmd('alpha', 'BODY') });
  assert.equal(await loadActiveSkillBody(db, 'P', 'alpha'), '---\nname: alpha\ndescription: Use when testing alpha.\n---\nBODY');
  await invoke(t, 'archive_skill', { name: 'alpha' });
  assert.equal(await loadActiveSkillBody(db, 'P', 'alpha'), null, 'archived not loadable');
  const msg = await invoke(t, 'load_skill', { name: 'alpha' });
  assert.match(msg, /No active skill named "alpha"/);
});

test('scheduled fire distinguishes active / archived / absent', async () => {
  const db = new FakeD1();
  const t = skillTools(db, 'P');
  await invoke(t, 'save_skill', { skill_md: mkmd('alpha') });
  assert.equal((await loadRunnableSkillBody(db, 'P', 'alpha')).status, 'active');
  await invoke(t, 'archive_skill', { name: 'alpha' });
  assert.equal((await loadRunnableSkillBody(db, 'P', 'alpha')).status, 'archived', 'archived is refusable, not silently absent');
  assert.equal((await loadRunnableSkillBody(db, 'P', 'ghost')).status, 'absent');
});

test('restore brings an archived skill back', async () => {
  const db = new FakeD1();
  const t = skillTools(db, 'P');
  await invoke(t, 'save_skill', { skill_md: mkmd('alpha') });
  await invoke(t, 'archive_skill', { name: 'alpha' });
  const restored = await invoke(t, 'restore_skill', { name: 'alpha' });
  assert.match(restored, /restored skill "alpha"/);
  assert.deepEqual((await loadSkillCatalog(db, 'P')).map((s) => s.name), ['alpha']);
  assert.equal((await loadRunnableSkillBody(db, 'P', 'alpha')).status, 'active');
  // restoring something not archived is a no-op message
  assert.match(await invoke(t, 'restore_skill', { name: 'alpha' }), /No archived skill named "alpha"/);
});

test('re-saving a name reactivates it and preserves created_at', async () => {
  const db = new FakeD1();
  const t = skillTools(db, 'P');
  await invoke(t, 'save_skill', { skill_md: mkmd('alpha', 'v1') });
  const created = db.rows[0].created_at;
  await invoke(t, 'archive_skill', { name: 'alpha' });
  await invoke(t, 'save_skill', { skill_md: mkmd('alpha', 'v2') });
  const row = db.rows[0];
  assert.equal(row.state, 'active', 're-save reactivates');
  assert.equal(row.archived_at, null);
  assert.match(row.body_md, /v2/, 'body updated');
  assert.equal(row.created_at, created, 'original authorship time preserved');
});

test('provenance is stamped on save', async () => {
  const db = new FakeD1();
  const t = skillTools(db, 'P');
  await invoke(t, 'save_skill', { skill_md: mkmd('alpha') });
  const row = db.rows[0];
  assert.equal(row.created_by, 'agent');
  assert.equal(row.updated_by, 'agent');
  assert.equal(row.state, 'active');
  assert.ok(row.created_at > 0 && row.updated_at > 0);
});

test('body caps: personality is tight (every-turn cost), ordinary skills generous', async () => {
  const db = new FakeD1();
  const t = skillTools(db, 'P');
  // Ordinary skill: fine at personality-breaking size, refused past MAX_BODY.
  await invoke(t, 'save_skill', { skill_md: mkmd('big-howto', 'x'.repeat(10_000)) });
  await assert.rejects(invoke(t, 'save_skill', { skill_md: mkmd('big-howto', 'x'.repeat(24_000)) }), /≤ 24000/);
  // Personality: refused past its tight cap, with the why in the error.
  await assert.rejects(
    invoke(t, 'save_skill', { skill_md: mkmd('personality', 'x'.repeat(6_000)) }),
    /EVERY turn/,
  );
  await invoke(t, 'save_skill', { skill_md: mkmd('personality', 'x'.repeat(3_000)) });
  assert.equal(db.rows.filter((r) => r.name === 'personality').length, 1);
});

test('skills are project-isolated', async () => {
  const db = new FakeD1();
  await invoke(skillTools(db, 'P1'), 'save_skill', { skill_md: mkmd('alpha') });
  assert.deepEqual(await loadSkillCatalog(db, 'P2'), [], 'P2 sees nothing of P1');
  assert.equal((await loadRunnableSkillBody(db, 'P2', 'alpha')).status, 'absent');
  // P2 cannot archive P1's skill, and P1's stays active
  assert.match(await invoke(skillTools(db, 'P2'), 'archive_skill', { name: 'alpha' }), /No active skill named "alpha"/);
  assert.equal((await loadRunnableSkillBody(db, 'P1', 'alpha')).status, 'active');
});

test('toolset has no hard-delete', async () => {
  const names = skillTools(new FakeD1(), 'P').map((t) => t.name).sort();
  assert.deepEqual(names, ['archive_skill', 'load_skill', 'restore_skill', 'save_skill']);
  assert.ok(!names.includes('delete_skill'), 'delete_skill must not exist — archive is the destructive ceiling');
});

test('project skills cannot shadow protected platform self-knowledge', async () => {
  const db = new FakeD1();
  const base = { description: 'Use when testing morehands.', state: 'active', created_by: 'seed', updated_by: 'seed', created_at: 1, updated_at: 1, archived_at: null };
  db.rows.push({ project_id: '__global__', name: 'morehands', body_md: mkmd('morehands', 'GLOBAL'), ...base });

  await assert.rejects(
    () => invoke(skillTools(db, 'P'), 'save_skill', { skill_md: mkmd('morehands', 'LOCAL') }),
    /protected platform skill/,
  );
  assert.equal(await loadActiveSkillBody(db, 'P', 'morehands'), mkmd('morehands', 'GLOBAL'));
});

test('project skills cannot restore a protected local override', async () => {
  const db = new FakeD1();
  const base = { description: 'Use when testing morehands.', created_by: 'agent', updated_by: 'agent', created_at: 1, updated_at: 1 };
  db.rows.push({ project_id: 'P', name: 'morehands', body_md: mkmd('morehands', 'STALE LOCAL'), state: 'archived', archived_at: 2, ...base });

  await assert.rejects(
    () => invoke(skillTools(db, 'P'), 'restore_skill', { name: 'morehands' }),
    /protected platform skill/,
  );
});

test('catalog merges __global__ with the channel; channel wins on name', async () => {
  const db = new FakeD1();
  const base = { description: 'd', body_md: 'b', state: 'active', created_by: 'seed', updated_by: 'seed', created_at: 1, updated_at: 1, archived_at: null };
  db.rows.push({ project_id: '__global__', name: 'using-connections', ...base });
  db.rows.push({ project_id: '__global__', name: 'personality', description: 'global-personality', body_md: 'GLOBAL', state: 'active', created_by: 'seed', updated_by: 'seed', created_at: 1, updated_at: 1, archived_at: null });
  db.rows.push({ project_id: 'C_X', name: 'personality', description: 'channel-personality', body_md: 'CHANNEL', state: 'active', created_by: 'agent', updated_by: 'agent', created_at: 1, updated_at: 1, archived_at: null });
  db.rows.push({ project_id: 'C_X', name: 'channel-only', ...base });

  const cat = await loadSkillCatalog(db, 'C_X');
  const names = cat.map((c) => c.name);
  assert.deepEqual(names, ['channel-only', 'personality', 'using-connections'], 'global ∪ channel, sorted, deduped');
  assert.equal(cat.find((c) => c.name === 'personality')!.description, 'channel-personality', 'channel wins on name');
});

test('loadActiveSkillBody: channel body wins over global; falls back to global', async () => {
  const db = new FakeD1();
  db.rows.push({ project_id: '__global__', name: 'using-connections', description: 'd', body_md: 'GLOBAL-BODY', state: 'active', created_by: 'seed', updated_by: 'seed', created_at: 1, updated_at: 1, archived_at: null });
  db.rows.push({ project_id: '__global__', name: 'personality', description: 'd', body_md: 'GLOBAL-P', state: 'active', created_by: 'seed', updated_by: 'seed', created_at: 1, updated_at: 1, archived_at: null });
  db.rows.push({ project_id: 'C_X', name: 'personality', description: 'd', body_md: 'CHANNEL-P', state: 'active', created_by: 'agent', updated_by: 'agent', created_at: 1, updated_at: 1, archived_at: null });

  assert.equal(await loadActiveSkillBody(db, 'C_X', 'using-connections'), 'GLOBAL-BODY', 'inherits global');
  assert.equal(await loadActiveSkillBody(db, 'C_X', 'personality'), 'CHANNEL-P', 'channel overrides global');
  assert.equal(await loadActiveSkillBody(db, 'C_X', 'nope'), null, 'absent in both → null');
});

test('a channel write does NOT touch __global__ (global catalog stays empty)', async () => {
  const db = new FakeD1();
  db.rows.push({ project_id: 'C_X', name: 'mine', description: 'd', body_md: 'b', state: 'active', created_by: 'agent', updated_by: 'agent', created_at: 1, updated_at: 1, archived_at: null });
  const globalCat = await loadSkillCatalog(db, '__global__');
  // loadSkillCatalog('__global__') binds (GLOBAL, '__global__') → both args identical → only global rows (none)
  assert.equal(globalCat.length, 0, '__global__ unaffected by a channel write');
});

test('loadRunnableSkillBody: resolves a GLOBAL skill scheduled by a channel (active)', async () => {
  const db = new FakeD1();
  db.rows.push({ project_id: '__global__', name: 'using-connections', description: 'd', body_md: 'GLOBAL-BODY', state: 'active', created_by: 'seed', updated_by: 'seed', created_at: 1, updated_at: 1, archived_at: null });
  const r = await loadRunnableSkillBody(db, 'C_X', 'using-connections');
  assert.equal(r.status, 'active');
  if (r.status === 'active') assert.equal(r.body, 'GLOBAL-BODY');
});

test('loadRunnableSkillBody: channel override wins over global', async () => {
  const db = new FakeD1();
  db.rows.push({ project_id: '__global__', name: 'personality', description: 'd', body_md: 'GLOBAL-P', state: 'active', created_by: 'seed', updated_by: 'seed', created_at: 1, updated_at: 1, archived_at: null });
  db.rows.push({ project_id: 'C_X', name: 'personality', description: 'd', body_md: 'CHANNEL-P', state: 'active', created_by: 'agent', updated_by: 'agent', created_at: 1, updated_at: 1, archived_at: null });
  const r = await loadRunnableSkillBody(db, 'C_X', 'personality');
  assert.equal(r.status, 'active');
  if (r.status === 'active') assert.equal(r.body, 'CHANNEL-P', 'channel wins');
});

test('loadRunnableSkillBody: a channel-archived override falls back to the global active body', async () => {
  // If the channel archived its override, scheduled fire should run the GLOBAL skill (not refuse).
  const db = new FakeD1();
  db.rows.push({ project_id: '__global__', name: 'personality', description: 'd', body_md: 'GLOBAL-P', state: 'active', created_by: 'seed', updated_by: 'seed', created_at: 1, updated_at: 1, archived_at: null });
  db.rows.push({ project_id: 'C_X', name: 'personality', description: 'd', body_md: 'CH', state: 'archived', created_by: 'agent', updated_by: 'agent', created_at: 1, updated_at: 1, archived_at: 2 });
  const r = await loadRunnableSkillBody(db, 'C_X', 'personality');
  assert.equal(r.status, 'active', 'archived channel override → falls back to global active');
  if (r.status === 'active') assert.equal(r.body, 'GLOBAL-P');
});

test('loadRunnableSkillBody: channel-archived with NO global → archived (refused)', async () => {
  const db = new FakeD1();
  db.rows.push({ project_id: 'C_X', name: 'mine', description: 'd', body_md: 'b', state: 'archived', created_by: 'agent', updated_by: 'agent', created_at: 1, updated_at: 1, archived_at: 2 });
  const r = await loadRunnableSkillBody(db, 'C_X', 'mine');
  assert.equal(r.status, 'archived');
});

test('loadRunnableSkillBody: absent in both → absent', async () => {
  const db = new FakeD1();
  const r = await loadRunnableSkillBody(db, 'C_X', 'nope');
  assert.equal(r.status, 'absent');
});

await run();
