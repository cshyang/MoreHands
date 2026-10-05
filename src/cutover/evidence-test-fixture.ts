import type { CoverageEvidence } from './evidence';
export function idleFixture(): CoverageEvidence {
  return {
    listing: { namespaceId: 'test-namespace', observedAt: 20, paginationComplete: true, objects: [{ id: 'object', hasStoredData: true }] },
    previousListing: { namespaceId: 'test-namespace', observedAt: 19, paginationComplete: true, objects: [{ id: 'object', hasStoredData: true }] },
    inventory: [{ namespaceId: 'test-namespace', objectId: 'object', generation: 'g2', runtimeVersion: '2.2.2',
      associationEvidence: 'TEST DATA: verified source/name association', instanceName: 'local@g2' }],
    observations: [{ namespaceId: 'test-namespace', objectId: 'object', generation: 'g2', runtimeVersion: '2.2.2', sdkVersion: '0.20.1',
      observedAt: 20, format: { key: 'format_version', value: '1' }, sdkSchemaVersion: '11', status: 'observed-idle', nativeStatuses: {},
      sdkStatuses: { fibers: {}, workflows: {}, toolRuns: {} }, counts: {
        runs: 0, facetRuns: 0, queues: 0, fibers: 0, fibersUnsuccessful: 0, workflows: 0, workflowsUnsuccessful: 0,
        toolRuns: 0, toolRunsUnsuccessful: 0, unresolvedChildren: 0, detachedPending: 0, schedules: 0, nativeSubmissions: 0, nativeErrors: 0,
      }, schedules: [], alarm: null, blockers: [], unknowns: [], limitations: [] }],
    producerCount: 0, controlState: 'closed', closedAt: 10,
    productCounts: { pendingMessages: 0, activeReceipts: 0, agentRuns: 0, workRuns: 0, notifications: 0, replyOutbox: 0, replyTrackers: 0,
      slackIngressPending: 0, slackIngressFailed: 0, slackIngressAckUncertain: 0, slackIngressStorageInvalid: 0 },
    unknowns: [], preBridgeRetirementEvidence: 'TEST DATA: old bundle retired', controlObservedAt: 20, producersObservedAt: 20,
    productObservedAt: 20, lastProducerFinishedAt: 15, deliveryDispositionEvidence: 'TEST DATA: delivery reconciled', observationTimingEvidence: null,
  };
}
