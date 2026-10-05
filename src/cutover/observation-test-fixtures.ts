import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { ObservationSql, ObservationStorage } from './observation';

// Schema interpretation fixture: extracts code-owned DDL from pinned packages, not SDK execution.
export function sdkObservationFixture() {
  const sql = new DatabaseSync(':memory:');
  const source = readFileSync(new URL('../../node_modules/@flue/vite/node_modules/agents/dist/index.js', import.meta.url), 'utf8');
  for (const match of source.matchAll(/(CREATE TABLE IF NOT EXISTS (?:cf_agents_\w+|cf_agent_tool_runs) \([\s\S]*?)`/g)) {
    sql.exec(match[1]);
  }
  for (const match of source.matchAll(/addColumnIfNotExists\("(ALTER TABLE [^"]+)"\)/g)) {
    try { sql.exec(match[1]); } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('duplicate column')) throw error;
    }
  }
  sql.exec("INSERT INTO cf_agents_state(id,state) VALUES('cf_schema_version','11')");
  const queries: string[] = [];
  const observationSql: ObservationSql = { exec(query, ...bindings) {
    queries.push(query);
    return { toArray: () => sql.prepare(query).all(...bindings as never[]) as Array<Record<string, unknown>> };
  } };
  return { sql, observationSql, queries };
}
export function nativeObservationFixture() {
  const f = sdkObservationFixture();
  const source = readFileSync(new URL('../../node_modules/@flue/runtime/dist/sql-agent-execution-store-C0vwyWZB.mjs', import.meta.url), 'utf8');
  const ddl = source.match(/CREATE TABLE IF NOT EXISTS flue_agent_submissions \([\s\S]*?\n\s*\)/)![0];
  f.sql.exec(ddl);
  f.sql.exec("CREATE TABLE flue_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO flue_meta VALUES('format_version','1')");
  let alarm: number | null = null;
  let destroy: unknown;
  const storage: ObservationStorage = { sql: f.observationSql, getAlarm: async () => alarm, get: async <T>() => destroy as T | undefined };
  return { ...f, storage,
    alarm: (value: number | null) => { alarm = value; }, destroy: (value: unknown) => { destroy = value; },
    seedSubmission: (status: string, id = 's') => f.sql.prepare(`INSERT INTO flue_agent_submissions
      (submission_id,session_key,kind,payload,status,accepted_at,settled_at) VALUES(?,'session','message','private-payload',?,1,?)`)
      .run(id, status, status === 'settled' ? 2 : null),
  };
}
