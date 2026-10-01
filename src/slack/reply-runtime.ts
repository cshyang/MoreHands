import { extend, type CloudflareAgentLike } from '@flue/runtime/cloudflare';
import type { D1Like } from '../skills/repository';
import { nativeReplyHistory, reconcileReplyHistory, type ReplySettlement } from './delivery';
import { deliverPendingReplies, finalizeDeliveredReplies } from './reply-outbox';

interface ReplyRuntimeEnv extends Record<string, unknown> {
  DB?: D1Like;
}
interface ReplyAgent extends CloudflareAgentLike {
  readonly name: string;
  runFiber<T>(name: string, callback: (context: { stash(snapshot: unknown): void }) => Promise<T>): Promise<T>;
}
const ATTEMPT_FIBER = 'flue:submission-attempt';
const REPLY_BACKSTOP_SECONDS = 30;

// Public Flue extension seam; native runtime construction, alarms and supervision
// remain untouched. The only pinned internal dependency is nativeReplyHistory.
export const replyRuntime = extend<ReplyAgent, ReplyRuntimeEnv>({
  base: (Base) => class ReplyRuntimeAgent extends Base {
    private readonly replyStorage: DurableObjectStorage;
    private readonly replyEnv: ReplyRuntimeEnv;
    private replyPass: Promise<ReplySettlement[]> = Promise.resolve([]);

    constructor(ctx: DurableObjectState, env: ReplyRuntimeEnv) {
      super(ctx, env);
      this.replyStorage = ctx.storage;
      this.replyEnv = env;
    }

    async onStart(props?: Record<string, unknown>): Promise<void> {
      await super.onStart(props);
      // Recovery includes a settled last fiber whose final wake never ran.
      if (this.replyEnv.DB) await this.schedule(0, 'reconcileReplies', undefined, { idempotent: true });
    }

    async runFiber<T>(name: string, callback: (context: { stash(snapshot: unknown): void }) => Promise<T>): Promise<T> {
      if (name !== ATTEMPT_FIBER || !this.replyEnv.DB) return super.runFiber(name, callback);
      // Arm BEFORE execution: a crash after native settlement but before finally
      // cannot strand its reply. Never replace the SDK/native alarm with setAlarm.
      await this.schedule(REPLY_BACKSTOP_SECONDS, 'reconcileReplies', undefined, { idempotent: false }).catch((error) => {
        console.log(`[reply] backstop wake failed: ${error instanceof Error ? error.message : 'error'}`);
      });
      try {
        return await super.runFiber(name, callback);
      } finally {
        // Native processSubmission settles canonical history before the fiber ends.
        // The existing durable backstop still owns recovery if this fast wake fails.
        await this.schedule(0, 'reconcileReplies', undefined, { idempotent: false }).catch((error) => {
          console.log(`[reply] settlement wake failed: ${error instanceof Error ? error.message : 'error'}`);
        });
      }
    }

    // Public DO RPC and Agents SDK scheduled callback. No model work is started here;
    // capture native truth, then immediately flush only this instance's product outbox.
    reconcileReplies(): Promise<ReplySettlement[]> {
      const pass = this.replyPass.then(async () => {
        const db = this.replyEnv.DB;
        if (!db) return [];
        try {
          const history = await nativeReplyHistory(this.replyStorage);
          const settlements = await reconcileReplyHistory(db, this.name, history);
          await deliverPendingReplies(db, this.replyEnv, this.name).catch((error) =>
            console.log(`[reply] delivery sweep failed: ${error instanceof Error ? error.message : 'error'}`));
          await finalizeDeliveredReplies(db, this.replyEnv, this.name);
          const pending = await db.prepare(`SELECT 1 FROM slack_reply_trackers
            WHERE instance_id=? AND status='pending' LIMIT 1`).bind(this.name).first();
          if (pending) await this.schedule(REPLY_BACKSTOP_SECONDS, 'reconcileReplies', undefined, { idempotent: false });
          return settlements;
        } catch (error) {
          await this.schedule(REPLY_BACKSTOP_SECONDS, 'reconcileReplies', undefined, { idempotent: false }).catch((wakeError) => {
            console.log(`[reply] retry wake failed: ${wakeError instanceof Error ? wakeError.message : 'error'}`);
          });
          throw error;
        }
      });
      this.replyPass = pass.catch(() => []);
      return pass;
    }
  },
});
