import * as v from 'valibot';
import type { Generation } from './admissions';
import type { InstanceObservation, ObservationStatus } from './observation';
export interface InventoryEntry {
  namespaceId: string; objectId: string; generation: Generation;
  runtimeVersion: '1.0.0-beta.1' | '2.2.2'; associationEvidence: string; instanceName?: string;
}
export interface NamespaceListing {
  namespaceId: string; observedAt: number; paginationComplete: boolean;
  objects: Array<{ id: string; hasStoredData?: boolean }>;
}
export interface CoverageEvidence {
  listing: NamespaceListing; previousListing: NamespaceListing | null;
  inventory: InventoryEntry[]; observations: InstanceObservation[];
  producerCount: number; controlState: 'open' | 'closed' | 'unknown'; closedAt: number | null;
  productCounts: Record<string, number>; unknowns: string[];
  preBridgeRetirementEvidence: string | null; controlObservedAt: number; producersObservedAt: number;
  productObservedAt: number; lastProducerFinishedAt: number | null;
  deliveryDispositionEvidence: string | null; observationTimingEvidence: string | null;
}
export interface CutoverReport {
  status: ObservationStatus; blockers: string[]; unknowns: string[];
  coverage: { listed: number; associated: number; observed: number }; limitations: string[];
}
const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const text = v.string();
const identity = { namespaceId: v.pipe(text, v.minLength(1)), objectId: v.pipe(text, v.minLength(1)) };
const generation = v.picklist(['g1', 'g2']);
const runtimeVersion = v.picklist(['1.0.0-beta.1', '2.2.2']);
const statuses = v.record(text, count);
const listingSchema = v.strictObject({ namespaceId: v.pipe(text, v.minLength(1)), observedAt: count,
  paginationComplete: v.boolean(), objects: v.array(v.strictObject({ id: v.pipe(text, v.minLength(1)), hasStoredData: v.optional(v.boolean()) })) });
export const observationSchema = v.strictObject({ ...identity, generation, runtimeVersion, sdkVersion: v.picklist(['0.15.0', '0.20.1']),
  observedAt: count, format: v.nullable(v.strictObject({ key: v.picklist(['schema_version', 'format_version']), value: text })),
  sdkSchemaVersion: v.nullable(text), status: v.picklist(['blocked', 'unknown', 'observed-idle']), nativeStatuses: statuses,
  sdkStatuses: v.record(text, statuses), counts: statuses,
  schedules: v.array(v.strictObject({ callback: text, type: text, owner: v.nullable(text), count })),
  alarm: v.nullable(count), blockers: v.array(text), unknowns: v.array(text), limitations: v.array(text) });
const evidenceSchema = v.strictObject({ listing: listingSchema, previousListing: v.nullable(listingSchema),
  inventory: v.array(v.strictObject({ ...identity, generation, runtimeVersion, associationEvidence: text, instanceName: v.optional(text) })),
  observations: v.array(observationSchema), producerCount: count, controlState: v.picklist(['open', 'closed', 'unknown']),
  closedAt: v.nullable(count), productCounts: statuses, unknowns: v.array(text), preBridgeRetirementEvidence: v.nullable(text),
  controlObservedAt: count, producersObservedAt: count, productObservedAt: count, lastProducerFinishedAt: v.nullable(count),
  deliveryDispositionEvidence: v.nullable(text), observationTimingEvidence: v.nullable(text) });
export const PRODUCT_KEYS = ['pendingMessages', 'activeReceipts', 'agentRuns', 'workRuns', 'notifications'] as const;
export const NATIVE_PRODUCT_KEYS = ['replyOutbox', 'replyTrackers', 'slackIngressPending', 'slackIngressFailed', 'slackIngressAckUncertain', 'slackIngressStorageInvalid'] as const;
function invalid(): never { throw new Error('invalid evidence'); }
function nonempty(value: string | null): boolean { return !!value?.trim(); }
function unique(values: string[]): Set<string> {
  const result = new Set(values); if (result.size !== values.length) invalid(); return result;
}
function checkInstance(observation: InstanceObservation, blockers: string[], unknowns: string[]): void {
  const beta = observation.generation === 'g1';
  const groups = [
    { key: 'fibers', active: ['pending', 'running'], terminal: ['completed', 'aborted', 'interrupted', 'error'] },
    { key: 'workflows', active: ['queued', 'running', 'paused', 'waiting', 'waitingForPause'], terminal: ['complete', 'errored', 'terminated'] },
    { key: 'toolRuns', active: ['starting', 'running'], terminal: ['completed', 'error', 'aborted', 'interrupted'] },
  ];
  const liveCounts = ['runs', 'facetRuns', 'queues', 'unresolvedChildren', 'schedules',
    ...(beta ? ['attemptMarkers', 'sessionDeletions', 'uncommittedJournals', 'observers'] : ['detachedPending'])];
  const required = [...liveCounts, 'nativeSubmissions', 'nativeErrors', ...groups.flatMap(x => [x.key, `${x.key}Unsuccessful`]),
    ...(beta ? ['journals'] : [])];
  for (const key of required) if (!(key in observation.counts)) unknowns.push(`instance count unavailable: ${key}`);
  if (Object.keys(observation.counts).some(key => !required.includes(key))) unknowns.push('instance count vocabulary unavailable');
  for (const key of liveCounts) if (observation.counts[key] > 0) blockers.push(`instance obligation: ${key}`);
  const sum = (values: Record<string, number>) => Object.values(values).reduce((total, n) => total + n, 0);
  const native = beta ? ['queued', 'running', 'settled'] : ['queued', 'running', 'terminalizing', 'settled', 'joining', 'joined'];
  if (Object.keys(observation.nativeStatuses).some(key => !native.includes(key))) unknowns.push('native status vocabulary unavailable');
  if (sum(observation.nativeStatuses) !== observation.counts.nativeSubmissions) unknowns.push('native status aggregate inconsistent');
  if (observation.counts.nativeErrors > (observation.nativeStatuses.settled ?? 0)) unknowns.push('native error aggregate inconsistent');
  if (Object.entries(observation.nativeStatuses).some(([status, n]) => status !== 'settled' && n > 0)) blockers.push('native execution outstanding');
  if (Object.keys(observation.sdkStatuses).some(key => !groups.some(x => x.key === key))) unknowns.push('SDK group vocabulary unavailable');
  for (const { key, active, terminal } of groups) {
    const statuses = observation.sdkStatuses[key];
    if (!statuses) { unknowns.push(`SDK status coverage unavailable: ${key}`); continue; }
    if (Object.keys(statuses).some(status => ![...active, ...terminal].includes(status))) unknowns.push(`SDK status vocabulary unavailable: ${key}`);
    if (Object.entries(statuses).some(([status, n]) => active.includes(status) && n > 0)) blockers.push(`SDK execution outstanding: ${key}`);
    if (sum(statuses) !== observation.counts[key]) unknowns.push(`SDK status aggregate inconsistent: ${key}`);
    const unsuccessful = ['error', 'errored', 'aborted', 'interrupted', 'terminated'].reduce((total, status) => total + (statuses[status] ?? 0), 0);
    if (unsuccessful !== observation.counts[`${key}Unsuccessful`]) unknowns.push(`SDK unsuccessful aggregate inconsistent: ${key}`);
  }
  if (observation.counts.unresolvedChildren > (observation.sdkStatuses.toolRuns?.interrupted ?? 0)
    || (!beta && observation.counts.detachedPending > observation.counts.toolRuns)) unknowns.push('SDK child or delivery aggregate inconsistent');
  if (beta && observation.counts.uncommittedJournals > observation.counts.journals) unknowns.push('beta journal aggregate inconsistent');
  if (observation.schedules.some(x => x.count === 0 || !['__flueWakeAgentSubmissions', 'reconcileReplies'].includes(x.callback)
    || !['scheduled', 'delayed', 'cron', 'interval'].includes(x.type) || (x.owner !== null && !/^owner-[1-9]\d*$/.test(x.owner)))) {
    unknowns.push('schedule detail unavailable');
  }
  const scheduleKeys = observation.schedules.map(x => JSON.stringify([x.callback, x.type, x.owner]));
  if (new Set(scheduleKeys).size !== scheduleKeys.length
    || observation.schedules.reduce((total, x) => total + x.count, 0) !== observation.counts.schedules) unknowns.push('schedule aggregate inconsistent');
}
export function evaluateCutoverEvidence(value: unknown, now = Date.now()): CutoverReport {
  const parsed = v.safeParse(evidenceSchema, value);
  if (!parsed.success || !Number.isSafeInteger(now) || now < 0) invalid();
  const input = parsed.output;
  const blockers: string[] = [], unknowns = [...input.unknowns];
  const namespace = input.listing.namespaceId;
  const listed = unique(input.listing.objects.map(x => x.id));
  const associated = unique(input.inventory.map(x => x.objectId));
  const observed = unique(input.observations.map(x => x.objectId));
  const checkTime = (time: number | null) => { if (time !== null && time > now) invalid(); };
  [input.listing.observedAt, input.previousListing?.observedAt ?? null, input.closedAt, input.lastProducerFinishedAt,
    input.controlObservedAt, input.producersObservedAt, input.productObservedAt, ...input.observations.map(x => x.observedAt)].forEach(checkTime);
  const previous = input.previousListing;
  if (previous) {
    if (previous.namespaceId !== namespace || previous.observedAt > input.listing.observedAt) invalid();
    const ids = unique(previous.objects.map(x => x.id));
    if (ids.size !== listed.size || [...ids].some(id => !listed.has(id))) unknowns.push('namespace listing changed');
    if (!previous.paginationComplete) unknowns.push('previous pagination incomplete');
  } else unknowns.push('previous listing unavailable');
  if (!input.listing.paginationComplete) unknowns.push('pagination incomplete');
  if (input.listing.objects.some(x => x.hasStoredData === undefined)) unknowns.push('stored-data coverage unavailable');
  for (const entry of input.inventory) {
    if (entry.namespaceId !== namespace || !listed.has(entry.objectId)) invalid();
    if (entry.runtimeVersion !== (entry.generation === 'g1' ? '1.0.0-beta.1' : '2.2.2')) invalid();
    if (!nonempty(entry.associationEvidence)) unknowns.push('runtime association unavailable');
    if (!observed.has(entry.objectId)) unknowns.push('instance observation unavailable');
  }
  for (const id of listed) if (!associated.has(id)) unknowns.push('unclassified namespace object');
  for (const observation of input.observations) {
    const entry = input.inventory.find(x => x.objectId === observation.objectId);
    if (observation.namespaceId !== namespace) invalid();
    if (!entry) { unknowns.push('observation association unavailable'); continue; }
    if (observation.generation !== entry.generation
      || observation.runtimeVersion !== entry.runtimeVersion
      || observation.sdkVersion !== (entry.generation === 'g1' ? '0.15.0' : '0.20.1')) invalid();
    const beta = entry.generation === 'g1';
    if (observation.format?.key !== (beta ? 'schema_version' : 'format_version') || observation.format?.value !== '1'
      || observation.sdkSchemaVersion !== (beta ? '9' : '11')) unknowns.push('instance format unavailable');
    blockers.push(...observation.blockers); unknowns.push(...observation.unknowns);
    if (observation.status === 'blocked' && !observation.blockers.length) blockers.push('instance blocked');
    if (observation.status === 'unknown' && !observation.unknowns.length) unknowns.push('instance unknown');
    if (observation.alarm !== null || observation.schedules.length) blockers.push('instance alarm or schedule outstanding');
    checkInstance(observation, blockers, unknowns);
  }
  const generations = unique([...new Set([...input.inventory, ...input.observations].map(x => x.generation))]);
  if (!generations.size) unknowns.push('runtime generation coverage unavailable');
  const required: string[] = [];
  for (const gen of generations) {
    for (const key of [...PRODUCT_KEYS, ...(gen === 'g2' ? NATIVE_PRODUCT_KEYS : [])]) {
      required.push(generations.size > 1 ? `${gen}.${key}` : key);
    }
  }
  if (Object.keys(input.productCounts).some(key => !required.includes(key))) invalid();
  for (const key of required) if (!(key in input.productCounts)) unknowns.push(`product count unavailable: ${key}`);
  for (const [key, n] of Object.entries(input.productCounts)) if (n > 0) blockers.push(`product obligation: ${key}`);
  if (input.controlState === 'open') blockers.push('admissions open');
  if (input.controlState === 'unknown') unknowns.push('admission control unavailable');
  if (input.producerCount > 0) blockers.push('producer operations outstanding');
  if (input.controlState === 'closed' && input.closedAt === null) unknowns.push('closure boundary unavailable');
  if (!nonempty(input.preBridgeRetirementEvidence)) unknowns.push('pre-bridge retirement evidence unavailable');
  if (!nonempty(input.deliveryDispositionEvidence)) unknowns.push('delivery disposition evidence unavailable');
  if (input.lastProducerFinishedAt === null && !nonempty(input.observationTimingEvidence)) unknowns.push('producer timing evidence unavailable');
  const boundary = Math.max(input.closedAt ?? 0, input.lastProducerFinishedAt ?? 0);
  for (const [key, time] of [ ['control', input.controlObservedAt], ['producers', input.producersObservedAt],
    ['product', input.productObservedAt], ['listing', input.listing.observedAt],
    ...input.observations.map(x => ['instance', x.observedAt]) ] as Array<[string, number]>) {
    if (time <= boundary) unknowns.push(`stale ${key} observation`);
  }
  return { status: blockers.length ? 'blocked' : unknowns.length ? 'unknown' : 'observed-idle',
    blockers: [...new Set(blockers)], unknowns: [...new Set(unknowns)],
    coverage: { listed: listed.size, associated: associated.size, observed: observed.size },
    limitations: ['observed-idle is not deployment or rollback authorization', 'Submitted evidence is not independently authenticated by this offline tool.',
      'Namespace listings and native/D1 reads are not an atomic fleet snapshot.'] };
}
