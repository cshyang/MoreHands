import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { evaluateCutoverEvidence, PRODUCT_KEYS, NATIVE_PRODUCT_KEYS, type CoverageEvidence } from './evidence';
const { test, run } = createTestRunner();
import { idleFixture } from './evidence-test-fixture';
test('complete matching idle evidence remains explicitly qualified', () => {
  const result = evaluateCutoverEvidence(idleFixture(), 30);
  assert.equal(result.status, 'observed-idle');
  assert.deepEqual(result.coverage, { listed: 1, associated: 1, observed: 1 });
  assert.ok(result.limitations.some(x => x.includes('not deployment or rollback authorization')));
});
for (const [name, mutate] of [
  ['open admissions', (f: CoverageEvidence) => { f.controlState = 'open'; }],
  ['outstanding producer', (f: CoverageEvidence) => { f.producerCount = 1; }],
  ...[...PRODUCT_KEYS, ...NATIVE_PRODUCT_KEYS].map(key =>
    [key, (f: CoverageEvidence) => { f.productCounts[key] = 1; }] as const),
  ['native blocker plus unknown', (f: CoverageEvidence) => { f.observations[0].status = 'blocked'; f.observations[0].blockers = ['unfinished-native']; f.unknowns = ['missing-retirement']; }],
] as const) test(`real blocker cannot become idle: ${name}`, () => {
  const f = idleFixture(); mutate(f); const result = evaluateCutoverEvidence(f, 30);
  assert.equal(result.status, 'blocked'); assert.ok(result.blockers.length);
  if (name === 'native blocker plus unknown') assert.ok(result.unknowns.includes('missing-retirement'));
});
for (const [name, mutate] of [
  ['pagination', (f: CoverageEvidence) => { f.listing.paginationComplete = false; }],
  ['previous listing absent', (f: CoverageEvidence) => { f.previousListing = null; }],
  ['listing changed', (f: CoverageEvidence) => { f.previousListing!.objects = []; }],
  ['missing stored-data coverage', (f: CoverageEvidence) => { delete f.listing.objects[0].hasStoredData; }],
  ['unclassified stored object', (f: CoverageEvidence) => { f.inventory = []; }],
  ['missing observation', (f: CoverageEvidence) => { f.observations = []; }],
  ['missing association', (f: CoverageEvidence) => { f.inventory[0].associationEvidence = ' '; }],
  ['missing product counts', (f: CoverageEvidence) => { f.productCounts = {}; }],
  ...[...PRODUCT_KEYS, ...NATIVE_PRODUCT_KEYS].map(key =>
    [`missing ${key}`, (f: CoverageEvidence) => { delete f.productCounts[key]; }] as const),
  ['retirement', (f: CoverageEvidence) => { f.preBridgeRetirementEvidence = null; }],
  ['delivery disposition', (f: CoverageEvidence) => { f.deliveryDispositionEvidence = ''; }],
  ['no producer timing', (f: CoverageEvidence) => { f.lastProducerFinishedAt = null; }],
  ['no closure boundary', (f: CoverageEvidence) => { f.closedAt = null; }],
  ['unknown control', (f: CoverageEvidence) => { f.controlState = 'unknown'; }],
  ['unknown schema', (f: CoverageEvidence) => { f.observations[0].format = null; f.observations[0].status = 'unknown'; f.observations[0].unknowns = ['format']; }],
  ...['controlObservedAt', 'producersObservedAt', 'productObservedAt'].map(key =>
    [`stale ${key}`, (f: CoverageEvidence) => { (f as any)[key] = 14; }] as const),
  ['stale listing', (f: CoverageEvidence) => { f.listing.observedAt = 14; f.previousListing!.observedAt = 13; }],
  ['stale native', (f: CoverageEvidence) => { f.observations[0].observedAt = 14; }],
] as const) test(`incomplete evidence fails closed: ${name}`, () => {
  const f = idleFixture(); mutate(f); const result = evaluateCutoverEvidence(f, 30);
  assert.equal(result.status, 'unknown'); assert.ok(result.unknowns.length);
});
for (const [name, mutate] of [
  ['negative producer', (f: CoverageEvidence) => { f.producerCount = -1; }],
  ['string count', (f: CoverageEvidence) => { f.productCounts.agentRuns = '0' as never; }],
  ['NaN count', (f: CoverageEvidence) => { f.productCounts.agentRuns = NaN; }],
  ['future timestamp', (f: CoverageEvidence) => { f.controlObservedAt = 31; }],
  ['out of order listing', (f: CoverageEvidence) => { f.previousListing!.observedAt = 21; }],
  ['duplicate listing ID', (f: CoverageEvidence) => { f.listing.objects.push({ id: 'object', hasStoredData: true }); }],
  ['duplicate inventory ID', (f: CoverageEvidence) => { f.inventory.push({ ...f.inventory[0] }); }],
  ['namespace mismatch', (f: CoverageEvidence) => { f.inventory[0].namespaceId = 'other'; }],
  ['beta under native identity', (f: CoverageEvidence) => { f.inventory[0].runtimeVersion = '1.0.0-beta.1'; }],
  ['observation runtime mismatch', (f: CoverageEvidence) => { f.observations[0].generation = 'g1'; }],
  ['unexpected input field', (f: CoverageEvidence) => { (f as any).safeToDeploy = true; }],
] as const) test(`invalid external data rejects: ${name}`, () => {
  const f = idleFixture(); mutate(f); assert.throws(() => evaluateCutoverEvidence(f, 30), /invalid evidence/);
});
test('explicit no-producer timing evidence is required and still qualified', () => {
  const f = idleFixture(); f.lastProducerFinishedAt = null; f.observationTimingEvidence = 'TEST DATA: no admissions since recorded closure';
  assert.equal(evaluateCutoverEvidence(f, 30).status, 'observed-idle');
});
test('beta and mixed fleet require generation-specific product coverage', () => {
  const beta = idleFixture();
  beta.inventory[0] = { ...beta.inventory[0], generation: 'g1', runtimeVersion: '1.0.0-beta.1', instanceName: 'local@g1' };
  beta.observations[0] = { ...beta.observations[0], generation: 'g1', runtimeVersion: '1.0.0-beta.1', sdkVersion: '0.15.0',
    format: { key: 'schema_version', value: '1' }, sdkSchemaVersion: '9' };
  delete beta.observations[0].counts.detachedPending;
  Object.assign(beta.observations[0].counts, { attemptMarkers: 0, sessionDeletions: 0, journals: 0, uncommittedJournals: 0, observers: 0 });
  for (const key of NATIVE_PRODUCT_KEYS) delete beta.productCounts[key];
  assert.equal(evaluateCutoverEvidence(beta, 30).status, 'observed-idle');
  const mixed = idleFixture();
  mixed.listing.objects.push({ id: 'beta-object', hasStoredData: true });
  mixed.previousListing!.objects.push({ id: 'beta-object', hasStoredData: true });
  mixed.inventory.push({ ...beta.inventory[0], objectId: 'beta-object' });
  mixed.observations.push({ ...beta.observations[0], objectId: 'beta-object' });
  mixed.productCounts = Object.fromEntries([
    ...Object.keys(mixed.productCounts).map(key => [`g2.${key}`, 0]),
    ...Object.keys(beta.productCounts).map(key => [`g1.${key}`, 0]),
  ]);
  assert.equal(evaluateCutoverEvidence(mixed, 30).status, 'observed-idle');
  delete mixed.productCounts['g1.agentRuns'];
  assert.equal(evaluateCutoverEvidence(mixed, 30).status, 'unknown');
  mixed.productCounts['g1.agentRuns'] = 0; mixed.productCounts['g2.replyOutbox'] = 1;
  assert.equal(evaluateCutoverEvidence(mixed, 30).status, 'blocked');
  mixed.inventory[0].generation = 'g1';
  assert.throws(() => evaluateCutoverEvidence(mixed, 30), /invalid evidence/);
});
function instanceFixture(beta: boolean): CoverageEvidence {
  const f = idleFixture();
  if (beta) {
    f.inventory[0] = { ...f.inventory[0], generation: 'g1', runtimeVersion: '1.0.0-beta.1', instanceName: 'local@g1' };
    Object.assign(f.observations[0], { generation: 'g1', runtimeVersion: '1.0.0-beta.1', sdkVersion: '0.15.0',
      format: { key: 'schema_version', value: '1' }, sdkSchemaVersion: '9' });
    delete f.observations[0].counts.detachedPending;
    Object.assign(f.observations[0].counts, { attemptMarkers: 0, sessionDeletions: 0, journals: 0, uncommittedJournals: 0, observers: 0 });
    for (const key of NATIVE_PRODUCT_KEYS) delete f.productCounts[key];
  }
  return f;
}
for (const beta of [false, true]) {
  const label = beta ? 'beta' : 'native';
  const complete = instanceFixture(beta).observations[0];
  for (const key of Object.keys(complete.counts)) test(`${label} missing instance counter ${key} is unknown`, () => {
    const f = instanceFixture(beta); delete f.observations[0].counts[key];
    assert.equal(evaluateCutoverEvidence(f, 30).status, 'unknown');
  });
  for (const key of ['runs', 'facetRuns', 'queues', 'unresolvedChildren', 'schedules',
    ...(beta ? ['attemptMarkers', 'sessionDeletions', 'uncommittedJournals', 'observers'] : ['detachedPending'])]) {
    test(`${label} positive ${key} blocks despite supplied idle status`, () => {
      const f = instanceFixture(beta); f.observations[0].counts[key] = 1;
      const result = evaluateCutoverEvidence(f, 30);
      assert.equal(result.status, 'blocked'); assert.ok(result.blockers.length);
    });
  }
  for (const [key, active] of [['fibers', 'running'], ['workflows', 'waiting'], ['toolRuns', 'starting']]) {
    test(`${label} active ${key} blocks despite supplied idle status`, () => {
      const f = instanceFixture(beta); f.observations[0].counts[key] = 1; f.observations[0].sdkStatuses[key][active] = 1;
      assert.equal(evaluateCutoverEvidence(f, 30).status, 'blocked');
    });
    test(`${label} missing ${key} status coverage is unknown`, () => {
      const f = instanceFixture(beta); delete f.observations[0].sdkStatuses[key];
      assert.equal(evaluateCutoverEvidence(f, 30).status, 'unknown');
    });
    test(`${label} incomplete ${key} aggregates are unknown`, () => {
      const f = instanceFixture(beta); f.observations[0].counts[key] = 1;
      assert.equal(evaluateCutoverEvidence(f, 30).status, 'unknown');
    });
  }
  for (const [name, mutate] of [
    ['empty counters', (o: typeof complete) => { o.counts = {}; o.sdkStatuses = {}; }],
    ['missing native statuses', (o: typeof complete) => { o.counts.nativeSubmissions = 1; }],
    ['unknown native status', (o: typeof complete) => { o.nativeStatuses.foreign = 0; }],
    ['unknown SDK status', (o: typeof complete) => { o.sdkStatuses.fibers.foreign = 0; }],
    ['unknown SDK group', (o: typeof complete) => { o.sdkStatuses.foreign = {}; }],
    ['unknown counter', (o: typeof complete) => { o.counts.foreign = 0; }],
    ['unsuccessful aggregate mismatch', (o: typeof complete) => { o.counts.fibers = 1; o.sdkStatuses.fibers.error = 1; }],
    ['native errors exceed settled', (o: typeof complete) => { o.counts.nativeErrors = 1; }],
    ['schedule detail mismatch', (o: typeof complete) => { o.schedules = [{ callback: '__flueWakeAgentSubmissions', type: 'scheduled', owner: null, count: 0 }]; }],
  ] as const) test(`${label} inconsistent instance evidence: ${name}`, () => {
    const f = instanceFixture(beta); mutate(f.observations[0]);
    const result = evaluateCutoverEvidence(f, 30);
    assert.notEqual(result.status, 'observed-idle'); assert.ok(result.unknowns.length);
  });
  test(`${label} known completed records do not become execution blockers`, () => {
    const f = instanceFixture(beta), o = f.observations[0];
    o.counts.nativeSubmissions = 2; o.nativeStatuses.settled = 2; o.counts.nativeErrors = 1;
    for (const [key, terminal] of [['fibers', 'completed'], ['workflows', 'complete'], ['toolRuns', 'completed']]) {
      o.counts[key] = 2; o.sdkStatuses[key][terminal] = 2;
    }
    assert.equal(evaluateCutoverEvidence(f, 30).status, 'observed-idle');
  });
}
await run();
