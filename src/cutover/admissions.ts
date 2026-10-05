import type { D1Like } from '../skills/repository';

export type Generation = 'g1' | 'g2';
export type ProducerSource = 'slack' | 'linear' | 'scheduled' | 'work-item'
  | 'reminder-scan' | 'reflect' | 'review' | 'heartbeat';
export interface CutoverEnv { CUTOVER_CONTROL?: unknown; DB?: D1Like }
export interface Admission { id: string; generation: Generation; source: string }
export class AdmissionUnavailable extends Error {
  constructor() { super('admissions unavailable'); }
}

function enabled(env: CutoverEnv): D1Like | null {
  if (env.CUTOVER_CONTROL === undefined) return null;
  if (env.CUTOVER_CONTROL !== 'd1' || !env.DB) throw new AdmissionUnavailable();
  return env.DB;
}
function changes(result: unknown): number {
  const value = (result as { meta?: { changes?: unknown } } | null)?.meta?.changes;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new AdmissionUnavailable();
  return value;
}
async function register(env: CutoverEnv, generation: Generation, source: string,
  kind: 'intake' | 'drain', id: string, now: number): Promise<Admission | null> {
  const db = enabled(env);
  if (!db) return null;
  if (!id || !source || !Number.isSafeInteger(now) || now < 0) throw new AdmissionUnavailable();
  try {
    // Registration and closure order on the same primary row, without a read/insert gap.
    const result = await db.prepare(`INSERT INTO cutover_producers(id,source,generation,kind,admitted_at)
      SELECT ?,?,?,?,? FROM cutover_control WHERE id=1 AND ${kind === 'intake'
        ? "state='open'" : "state IN ('open','closed')"}`).bind(id, source, generation, kind, now).run();
    if (changes(result) !== 1) throw new AdmissionUnavailable();
    return { id, source, generation };
  } catch { throw new AdmissionUnavailable(); }
}
export function beginIntake(env: CutoverEnv, generation: Generation,
  source: ProducerSource, id: string = crypto.randomUUID(), now = Date.now()): Promise<Admission | null> {
  return register(env, generation, source, 'intake', id, now);
}
// Only trusted accepted-work recovery calls this; public routes never select the kind.
export function beginDrain(env: CutoverEnv, generation: Generation,
  source: 'accepted-runs' | 'parked-messages', id: string = crypto.randomUUID(), now = Date.now()): Promise<Admission | null> {
  return register(env, generation, source, 'drain', id, now);
}
export async function releaseAdmission(db: D1Like, admission: Admission): Promise<void> {
  try {
    const result = await db.prepare('DELETE FROM cutover_producers WHERE id=? AND generation=? AND source=?')
      .bind(admission.id, admission.generation, admission.source).run();
    if (changes(result) !== 1) throw new AdmissionUnavailable();
  } catch { throw new AdmissionUnavailable(); }
}
export async function setAdmissionState(db: D1Like, expectedRevision: number,
  state: 'open' | 'closed', now = Date.now()): Promise<boolean> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    || !Number.isSafeInteger(now) || now < 0 || (state !== 'open' && state !== 'closed')) {
    throw new AdmissionUnavailable();
  }
  try {
    const result = await db.prepare(`UPDATE cutover_control SET state=?,revision=revision+1,updated_at=?
      WHERE id=1 AND revision=? AND state IN ('open','closed')`).bind(state, now, expectedRevision).run();
    const count = changes(result);
    if (count > 1) throw new AdmissionUnavailable();
    if (count === 0) {
      const row = await db.prepare('SELECT state,revision FROM cutover_control WHERE id=1').bind()
        .first<{ state: string; revision: number }>();
      if (!row || !['open', 'closed'].includes(row.state) || !Number.isSafeInteger(row.revision)) {
        throw new AdmissionUnavailable();
      }
    }
    return count === 1;
  } catch { throw new AdmissionUnavailable(); }
}
