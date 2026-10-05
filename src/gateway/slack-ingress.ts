import { FlueError, SubmissionConflictError, type AgentDispatchRequest, type DispatchReceipt } from '@flue/runtime';
import { prepareProjectDispatch, dispatchPreparedProject } from './dispatch';
import { ProjectAdmissionError } from './dispatch-message';
import { prepareAcceptedSlackEvent, guardedIngressEffectsDb } from '../slack/accepted-event';
import { storeFrozenRequest, loadFrozenRequest, FrozenRequestInvalid } from '../slack/frozen-request';
import { withIngressBudget, ingressStageDb, remainingIngressBudget, IngressBudgetDeferred } from '../slack/ingress-budget';
import { requireIngressDb, readSlackIngress, claimSlackIngress, completeSlackIngress, deferSlackIngress, failSlackIngress,
  listRecoverableSlackIngress, ingressBackoff, type FrozenIngressRoute } from '../slack/ingress-store';
import { IngressConflict } from '../slack/ingress-store';
import { withWallClock } from '../shared/wall-clock';

interface RecoveryDependencies {
  prepare: typeof prepareProjectDispatch;
  dispatch: (request: AgentDispatchRequest) => Promise<DispatchReceipt>;
}
const defaultDependencies: RecoveryDependencies = { prepare: prepareProjectDispatch, dispatch: dispatchPreparedProject };
export async function recoverSlackIngress(inputEnv: Record<string, unknown>,
  options: { limit?: number; now?: number; ingressId?: string } = {}, deps: RecoveryDependencies = defaultDependencies): Promise<{ processed: number; remaining: number }> {
  const env = withIngressBudget(inputEnv), db = requireIngressDb(env.DB), stage = ingressStageDb(db);
  const started = Date.now(), clock = options.now === undefined ? Date.now : () => options.now! + Math.max(0, Date.now() - started);
  const countRemaining = async () => Number((await db.prepare("SELECT COUNT(*) AS n FROM slack_ingress WHERE state<>'accepted'").bind().first<{ n: number }>())?.n ?? NaN);
  if (remainingIngressBudget(db) < 10) return { processed: 0,
    remaining: remainingIngressBudget(db) > 0 ? await countRemaining() : NaN }; // unavailable count is never zero
  const candidates = options.ingressId ? [options.ingressId]
    : await listRecoverableSlackIngress(stage, clock(), 8);
  let processed = 0;
  for (const id of [...new Set(candidates)]) {
    const row = await readSlackIngress(stage, id);
    if (!row || !['received','preparing','ready','uncertain'].includes(row.state)) continue;
    const phase = row.state === 'received' || row.state === 'preparing' ? 'prepare' : 'handoff';
    const claimed = await claimSlackIngress(stage, id, { owner: crypto.randomUUID(), phase, now: clock(), leaseMs: 60_000 });
    if (!claimed) continue;
    let lease = claimed;
    processed++;
    try {
      if (phase === 'prepare') {
        const preparation = await prepareAcceptedSlackEvent({ ...env, DB: stage, __ingressClock: clock }, row, lease);
        if (preparation.kind === 'quiet') { await completeSlackIngress(stage, lease, null, clock()); break; }
        if (preparation.kind === 'pending-ack') {
          const now = clock(); await deferSlackIngress(db, lease, 'ack-uncertain', now,
            now + Math.max(ingressBackoff(row.prepare_attempts + 1), preparation.retryAfterMs ?? 0)); break;
        }
        const request = await deps.prepare({ ...env, DB: guardedIngressEffectsDb(stage, lease, clock) }, preparation.request,
          { expectedRoute: preparation.route });
        if (!await storeFrozenRequest(stage, lease, request, clock())) break;
        if (remainingIngressBudget(db) < 20) break;
        const handoff = await claimSlackIngress(stage, id, { owner: crypto.randomUUID(), phase: 'handoff', now: clock(), leaseMs: 60_000 });
        if (!handoff) break;
        lease = handoff;
      }
      const request = await loadFrozenRequest(stage, id);
      const current = await readSlackIngress(stage, id);
      if (!current || current.lease_owner !== lease.owner || current.revision !== lease.revision || (current.lease_expires_at ?? 0) <= clock()) break;
      const route = JSON.parse(current.target_json!) as FrozenIngressRoute;
      if (request.id !== route.instanceId || request.idempotencyKey !== `slack:${route.deliveryEventId}`) throw new IngressConflict();
      const receipt = await withWallClock(deps.dispatch(request), 20_000, 'Native admission');
      await completeSlackIngress(stage, lease, receipt, clock());
    } catch (error) {
      // Primary readback first: an operation may have committed before losing its response.
      const after = await readSlackIngress(db, id);
      if (after?.state === 'accepted') break;
      if (!after || after.lease_owner !== lease.owner || after.revision !== lease.revision || (after.lease_expires_at ?? 0) <= clock()) break;
      const now = clock(), attempts = lease.phase === 'prepare' ? after.prepare_attempts : after.handoff_attempts;
      const budgetError = error instanceof IngressBudgetDeferred || remainingIngressBudget(db) <= 3;
      if (!budgetError && (after.ack_state === 'rejected' || error instanceof ProjectAdmissionError
        || error instanceof SubmissionConflictError || error instanceof IngressConflict || error instanceof FrozenRequestInvalid
        || error instanceof FlueError && error.type === 'invalid_request')) {
        await failSlackIngress(db, lease, error instanceof FrozenRequestInvalid ? 'storage-invalid' : error instanceof SubmissionConflictError ? 'native-conflict' : 'definitive-rejection', now);
      } else {
        await deferSlackIngress(db, lease, budgetError ? 'budget-deferred' : lease.phase === 'handoff' ? 'native-uncertain' : 'preparation-deferred', now, now + ingressBackoff(attempts));
      }
    }
    break; // one record may advance both phases; this is not a model execution loop
  }
  return { processed, remaining: await countRemaining() };
}
