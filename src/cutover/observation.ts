export type ObservationStatus = 'blocked' | 'unknown' | 'observed-idle';
export interface ObservationIdentity { namespaceId: string; objectId: string }
export interface ObservationSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> };
}
export interface ObservationStorage {
  sql: ObservationSql;
  getAlarm(): Promise<number | null>;
  get<T>(key: string): Promise<T | undefined>;
}
export interface InstanceObservation extends ObservationIdentity {
  generation: 'g1' | 'g2';
  runtimeVersion: '1.0.0-beta.1' | '2.2.2';
  sdkVersion: '0.15.0' | '0.20.1';
  observedAt: number;
  format: { key: 'schema_version' | 'format_version'; value: string } | null;
  sdkSchemaVersion: string | null;
  status: ObservationStatus;
  nativeStatuses: Record<string, number>;
  sdkStatuses: Record<string, Record<string, number>>;
  counts: Record<string, number>;
  schedules: Array<{ callback: string; type: string; owner: string | null; count: number }>;
  alarm: number | null;
  blockers: string[];
  unknowns: string[];
  limitations: string[];
}
// All callers pass fixed code-owned table names, never request values.
export function requireColumns(sql: ObservationSql, table: string, columns: string[]): void {
  if (!sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).toArray().length) throw new Error('schema unavailable');
  const names = new Set(sql.exec(`PRAGMA table_info(${table})`).toArray().map(row => row.name));
  if (columns.some(column => !names.has(column))) throw new Error('schema unavailable');
}
export function observationCount(sql: ObservationSql, query: string): number {
  return validCount(sql.exec(query).toArray()[0]?.count);
}
export function validCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid count');
  return value;
}
export interface SdkObservation {
  sdkSchemaVersion: string | null;
  sdkStatuses: Record<string, Record<string, number>>;
  counts: Record<string, number>;
  schedules: InstanceObservation['schedules'];
  blockers: string[];
  unknowns: string[];
}
