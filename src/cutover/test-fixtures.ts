import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { D1Like } from '../skills/repository';

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function sqliteD1() {
  const sql = new DatabaseSync(':memory:');
  const db: D1Like = { prepare: query => ({ bind: (...values) => ({
    run: async () => ({ meta: { changes: Number(sql.prepare(query).run(...values as never[]).changes) } }),
    first: async <T>() => (sql.prepare(query).get(...values as never[]) ?? null) as T | null,
    all: async <T>() => ({ results: sql.prepare(query).all(...values as never[]) as T[] }),
  }) }) };
  return { sql, db };
}

export function readMigration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}
