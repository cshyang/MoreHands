import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { BoundD1Statement, IngressDb, VerifiedIngressEvent } from '../ingress-store';

export function ingressDbFixture(state: 'open' | 'closed' = 'open') {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const name of readdirSync(new URL('../../../migrations/', import.meta.url)).filter(n => n.endsWith('.sql')).sort()) {
    sql.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8'));
  }
  sql.prepare('UPDATE cutover_control SET state=?').run(state);
  const statements = new WeakMap<object, { query: string; values: unknown[] }>();
  let loseCommit = false;
  const db: IngressDb = {
    prepare: query => ({ bind: (...values) => {
      const statement = {
        run: async () => ({ success: true, meta: { changes: Number(sql.prepare(query).run(...values as never[]).changes) } }),
        first: async <T>() => (sql.prepare(query).get(...values as never[]) ?? null) as T | null,
        all: async <T>() => ({ results: sql.prepare(query).all(...values as never[]) as T[] }),
      };
      statements.set(statement, { query, values });
      return statement;
    } }),
    batch: async (batch: BoundD1Statement[]) => {
      sql.exec('BEGIN');
      let results;
      try {
        results = batch.map(statement => {
          const s = statements.get(statement)!;
          const prepared = sql.prepare(s.query);
          const before = Number(sql.prepare('SELECT total_changes() AS n').get()!.n);
          const rows = prepared.columns().length ? prepared.all(...s.values as never[]) : (prepared.run(...s.values as never[]), []);
          const after = Number(sql.prepare('SELECT total_changes() AS n').get()!.n);
          return { success: true, results: rows, meta: { changes: after - before } };
        });
        sql.exec('COMMIT');
      } catch (error) { sql.exec('ROLLBACK'); throw error; }
      if (loseCommit) { loseCommit = false; throw new Error('fixture lost commit response'); }
      return results;
    },
  };
  return { db, sql,
    count: (table: string) => Number(sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n),
    closeIntake: () => sql.exec("UPDATE cutover_control SET state='closed',revision=revision+1"),
    openIntake: () => sql.exec("UPDATE cutover_control SET state='open',revision=revision+1"),
    loseNextCommitResponse: () => { loseCommit = true; },
    dispose: () => sql.close(),
  };
}

export function verifiedFixture(eventId = 'E1', digest = 'a'.repeat(64)): VerifiedIngressEvent {
  return { key: `T:${eventId}`, teamId: 'T', eventId, digest,
    eventJson: JSON.stringify({ team_id: 'T', event_id: eventId, event: { type: 'message', channel: 'C', ts: '1.0', user: 'U', text: 'hello' } }) };
}
