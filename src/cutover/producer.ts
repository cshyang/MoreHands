import { AdmissionUnavailable, releaseAdmission, type Admission, type CutoverEnv } from './admissions';

export interface ProducerScope {
  admission: Admission | null;
  track<T>(promise: Promise<T>): Promise<T>;
  finish(succeeded: boolean): Promise<void>;
}
export function createProducerScope(env: CutoverEnv, admission: Admission | null): ProducerScope {
  const pending = new Set<Promise<void>>();
  let failed = false;
  let finished = false;
  let finishing: Promise<void> | undefined;
  return {
    admission,
    track<T>(promise: Promise<T>): Promise<T> {
      if (finished) throw new Error('producer already finished');
      const observed = promise.then(() => {}, () => { failed = true; });
      pending.add(observed);
      void observed.then(() => pending.delete(observed));
      return promise;
    },
    finish(succeeded: boolean): Promise<void> {
      if (!succeeded) failed = true;
      if (finishing) return finishing;
      finishing = (async () => {
        // A tracked parent can register children before settling; drain until empty.
        while (pending.size) await Promise.all(pending);
        finished = true;
        if (failed || !admission) return;
        if (!env.DB) throw new AdmissionUnavailable();
        await releaseAdmission(env.DB, admission);
      })();
      return finishing;
    },
  };
}
