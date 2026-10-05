import type { D1Like } from '../skills/repository';
import type { IngressDb, BoundD1Statement } from './ingress-store';

export interface IngressBudget { used: number; limit: number; reserved: number }
interface Allocation { remaining: number; released: boolean; parent?: Allocation }
interface Scope {
  budget: IngressBudget;
  original: IngressDb;
  statements: WeakMap<object, BoundD1Statement>;
  allocation?: Allocation;
}
const scopes = new WeakMap<object, Scope>();
export class IngressBudgetDeferred extends Error { constructor() { super('Ingress invocation budget exhausted'); } }

function available(scope: Scope): number {
  return scope.allocation ? scope.allocation.released ? 0 : scope.allocation.remaining
    : scope.budget.limit - scope.budget.used - scope.budget.reserved;
}
function countedDb(scope: Scope): IngressDb {
  const charge = (n: number) => {
    if (available(scope) < n) throw new IngressBudgetDeferred();
    if (scope.allocation) { scope.allocation.remaining -= n; scope.budget.reserved -= n; }
    scope.budget.used += n;
  };
  const db: IngressDb = {
    prepare: query => ({ bind: (...values) => {
      const actual = scope.original.prepare(query).bind(...values);
      const wrapped = {
        run: () => { charge(1); return actual.run(); },
        first: <T>() => { charge(1); return actual.first<T>(); },
        all: <T>() => { charge(1); return actual.all<T>(); },
      };
      scope.statements.set(wrapped, actual); return wrapped;
    } }),
    batch: statements => {
      if (typeof scope.original.batch !== 'function') throw new Error('Ingress batch unavailable');
      charge(statements.length);
      return scope.original.batch(statements.map(s => scope.statements.get(s) ?? s));
    },
  };
  scopes.set(db, scope); return db;
}
/** Copies the environment per invocation; in-process calls and waitUntil share this scope. */
export function withIngressBudget<T extends { DB?: D1Like }>(env: T, limit = 50): T {
  if (!env.DB || scopes.has(env.DB)) return env;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid ingress budget');
  const db = countedDb({ original: env.DB as IngressDb, statements: new WeakMap(),
    budget: { used: 0, limit, reserved: 0 } });
  return { ...env, DB: db };
}
export function remainingIngressBudget(db: D1Like): number {
  const scope = scopes.get(db); return scope ? Math.max(0, available(scope)) : 50;
}
export function ingressBudget(db: D1Like): Readonly<IngressBudget> | undefined { return scopes.get(db)?.budget; }
export interface QueryReservation { db: IngressDb; release(): void }
/** Hold the whole bounded operation before its first write/network call; unused slots return. */
export function reserveIngressBudget(db: D1Like, statements: number): QueryReservation | null {
  if (!Number.isSafeInteger(statements) || statements < 1) throw new Error('Invalid query reservation');
  const scope = scopes.get(db);
  // Optional for legacy callers outside a counted invocation.
  if (!scope) return { db: db as IngressDb, release() {} };
  if (available(scope) < statements) return null;
  if (scope.allocation) scope.allocation.remaining -= statements;
  else scope.budget.reserved += statements;
  const allocation: Allocation = { remaining: statements, released: false, parent: scope.allocation };
  return { db: countedDb({ ...scope, allocation }), release() {
    if (allocation.released) return;
    allocation.released = true;
    if (allocation.parent && !allocation.parent.released) allocation.parent.remaining += allocation.remaining;
    else scope.budget.reserved -= allocation.remaining;
    allocation.remaining = 0;
  } };
}
/** Divide a recovery pass so a populated earlier stage cannot spend a later stage's share. */
export function reserveIngressBudgetShare(db: D1Like, stages: number, minimum = 1): QueryReservation | null {
  if (!scopes.has(db)) return reserveIngressBudget(db, minimum);
  const size = Math.floor(remainingIngressBudget(db) / stages);
  return size >= minimum ? reserveIngressBudget(db, size) : null;
}
/** Reserve primary operations for the final ingress deferral even if a helper catches an error. */
export function ingressStageDb(db: IngressDb, reserve = 3): IngressDb {
  const originals = new WeakMap<object, BoundD1Statement>();
  const check = (n = 1) => { if (remainingIngressBudget(db) < n + reserve) throw new IngressBudgetDeferred(); };
  const stage: IngressDb = { prepare: query => ({ bind: (...values) => {
    const actual = db.prepare(query).bind(...values);
    const wrapped = {
      run: () => { check(); return actual.run(); }, first: <R>() => { check(); return actual.first<R>(); },
      all: <R>() => { check(); return actual.all<R>(); },
    };
    originals.set(wrapped, actual); return wrapped;
  } }), batch: statements => { check(statements.length); return db.batch(statements.map(s => originals.get(s) ?? s)); } };
  const scope = scopes.get(db); if (scope) scopes.set(stage, scope);
  return stage;
}
