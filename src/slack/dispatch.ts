import { queueSetupFailureFallback, type QueueWorkingAckInput, type SlackPostMessage } from './ack';
import { ProjectAdmissionError, type ProjectDispatchRequest } from '../gateway/dispatch-message';

export interface DispatchSlackTurnDeps {
  dispatch(request: ProjectDispatchRequest): Promise<unknown>;
  onAccepted?: (receipt: unknown) => Promise<void>;
  onRejected?: () => Promise<void>;
  postMessage?: SlackPostMessage;
  log?: (message: string) => void;
}

export async function dispatchSlackTurnWithFallback(
  dispatchRequest: ProjectDispatchRequest,
  fallbackTarget: QueueWorkingAckInput,
  deps: DispatchSlackTurnDeps,
): Promise<{ dispatched: boolean }> {
  try {
    const receipt = await deps.dispatch(dispatchRequest);
    // Admission already succeeded. Bookkeeping cannot turn accepted native work into a
    // second failure answer (or tempt the gateway to resend an admitted message).
    try {
      await deps.onAccepted?.(receipt);
    } catch (e) {
      (deps.log ?? console.log)(`[slack] accepted submission bookkeeping failed: ${e instanceof Error ? e.message : 'error'}`);
    }
    return { dispatched: true };
  } catch (e) {
    const log = deps.log ?? console.log;
    log(`[slack] agent dispatch failed after working ack: ${e instanceof Error ? e.message : 'error'}`);
    if (e instanceof ProjectAdmissionError) {
      try { await deps.onRejected?.(); }
      catch (error) { log(`[slack] rejection bookkeeping failed: ${error instanceof Error ? error.message : 'error'}`); }
      queueSetupFailureFallback(fallbackTarget, { postMessage: deps.postMessage, log });
    }
    // An unknown native boundary failure may already be admitted. Keep its durable
    // tracker pending for history recovery and do not publish a contradictory failure.
    return { dispatched: false };
  }
}
