import type { D1Like } from '../skills/repository';
import { reserveIngressBudget, reserveIngressBudgetShare } from '../slack/ingress-budget';
import { deliverPendingReplies, finalizeDeliveredReplies } from '../slack/reply-outbox';

export interface ReplyAgentStub {
  setName(name: string): Promise<void>;
  reconcileReplies(): Promise<unknown>;
}
export interface ReplyAgentNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): ReplyAgentStub;
}

/** Match the pinned Agents getAgentByName bootstrap before calling custom DO RPC. */
export async function reconcileNativeReplies(namespace: ReplyAgentNamespace | undefined, instanceId: string): Promise<unknown> {
  if (!namespace) throw new Error('Missing native Project agent namespace');
  const stub = namespace.get(namespace.idFromName(instanceId));
  await stub.setName(instanceId);
  return stub.reconcileReplies();
}

export interface ReplyReconcileDeps {
  reconcileInstance(instanceId: string): Promise<unknown>;
  deliver?: typeof deliverPendingReplies;
  finalize?: typeof finalizeDeliveredReplies;
  now?: number;
  timeoutMs?: number;
  log?: (message: string) => void;
}

/** Native replay, external delivery and receipt repair are independent recovery phases. */
export async function reconcileReplies(db: D1Like, env: Record<string, unknown>, deps: ReplyReconcileDeps): Promise<{
  instances: number; replayFailures: number; deliveryFailed: boolean; finalizationFailed: boolean;
}> {
  const log = deps.log ?? console.log;
  const summary = { instances: 0, replayFailures: 0, deliveryFailed: false, finalizationFailed: false };
  const replay = reserveIngressBudgetShare(db, 3);
  if (replay) try {
    const { results } = await replay.db.prepare(`SELECT instance_id FROM slack_reply_trackers
      WHERE status='pending' OR (status IN ('silent','empty','failed','aborted') AND receipt_completed_at IS NULL) GROUP BY instance_id
      ORDER BY MIN(updated_at),MIN(created_at),instance_id LIMIT 10`).bind().all<{ instance_id: string }>();
    const jobs: Promise<void>[] = [];
    for (const { instance_id } of results) {
      const operation = reserveIngressBudget(replay.db, 1);
      if (!operation) break;
      summary.instances++;
      jobs.push((async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // Rotate attempted instances even if their native namespace is unavailable.
          await operation.db.prepare(`UPDATE slack_reply_trackers SET updated_at=? WHERE instance_id=? AND (status='pending' OR (status IN ('silent','empty','failed','aborted') AND receipt_completed_at IS NULL))`)
            .bind(deps.now ?? Date.now(), instance_id).run();
          await Promise.race([
            deps.reconcileInstance(instance_id),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Native reply replay timed out')), deps.timeoutMs ?? 10_000);
            }),
          ]);
        } catch (error) {
          summary.replayFailures++;
          log(`[reply] native replay failed: ${error instanceof Error ? error.message : 'error'}`);
        } finally { if (timer !== undefined) clearTimeout(timer); operation.release(); }
      })());
    }
    await Promise.all(jobs);
  } catch (error) {
    summary.replayFailures++;
    log(`[reply] replay enumeration failed: ${error instanceof Error ? error.message : 'error'}`);
  } finally { replay.release(); }
  const delivery = reserveIngressBudgetShare(db, 2);
  if (delivery) try { await (deps.deliver ?? deliverPendingReplies)(delivery.db, env); }
  catch (error) {
    summary.deliveryFailed = true;
    log(`[reply] outbox sweep failed: ${error instanceof Error ? error.message : 'error'}`);
  } finally { delivery.release(); }
  const finalization = reserveIngressBudgetShare(db, 1, 2);
  if (finalization) try { await (deps.finalize ?? finalizeDeliveredReplies)(finalization.db, env); }
  catch (error) {
    summary.finalizationFailed = true;
    log(`[reply] finalization failed: ${error instanceof Error ? error.message : 'error'}`);
  } finally { finalization.release(); }
  return summary;
}
