// Follow-up recovery invariants — run: npx tsx src/gateway/slack-ingress.test.ts

import assert from 'node:assert/strict';
import type { AgentDispatchRequest, DispatchReceipt } from '@flue/runtime';
import { createTestRunner } from '../shared/test-utils';
import { ingressDbFixture } from '../slack/test-utils/ingress-db';
import { route as baseRoute, snapshot } from '../slack/test-utils/frozen-request';
import { acceptSlackIngress, claimSlackIngress, readSlackIngress, updateLeasedIngress,
  listRecoverableSlackIngress, type IngressDb, type IngressLease, type IngressRow, type FrozenIngressRoute,
  type VerifiedIngressEvent } from '../slack/ingress-store';
import { storeFrozenRequest } from '../slack/frozen-request';
import { ingressBudget, withIngressBudget } from '../slack/ingress-budget';
import { recoverSlackIngress } from './slack-ingress';
import type { ProjectDispatchRequest } from './dispatch-message';

const { test, run } = createTestRunner();
const receipt: DispatchReceipt = { submissionId: 'S', uid: 'UID', acceptedAt: '2026-10-04T00:00:00Z' };

function verifiedEvent(eventId = 'E1'): VerifiedIngressEvent {
  const eventJson = JSON.stringify({
    team_id: 'T', event_id: eventId, api_app_id: 'A1',
    event: { type: 'message', channel: 'C', ts: '100.0', user: 'U', text: '<@B> please work' },
  });
  return { key: `T:${eventId}`, teamId: 'T', eventId, digest: 'a'.repeat(64), eventJson };
}

function frozenRoute(eventId = 'E1'): FrozenIngressRoute {
  return { ...baseRoute, mode: 'engaged', deliveryEventId: `T:${eventId}`, overhearNow: undefined };
}

function nativeRequest(eventId = 'E1'): AgentDispatchRequest {
  return {
    id: frozenRoute(eventId).instanceId!,
    message: 'durable native request',
    initialData: snapshot,
    idempotencyKey: `slack:T:${eventId}`,
  };
}

function preparedRequest(request: ProjectDispatchRequest): AgentDispatchRequest {
  return {
    id: request.id,
    message: 'prepared from current context',
    initialData: {},
    ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
  };
}

function insertBinding(db: IngressDb, projectId: string): Promise<unknown> {
  return db.prepare(
    'INSERT INTO bindings(project_id,provider,external_account_id,external_space_id,transport_bot_id,transport_token_ref,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).bind(projectId, 'slack', 'T', 'C', 'B', 'SLACK_BOT_TOKEN', 'active', 'test', 100, 100).run();
}

async function seedPreparing(f: ReturnType<typeof ingressDbFixture>, eventId = 'E1', id = 'I1'): Promise<IngressLease> {
  await acceptSlackIngress(f.db, verifiedEvent(eventId), { id, now: 100 });
  const lease = (await claimSlackIngress(f.db, id, { now: 100, owner: 'A', leaseMs: 60_000, phase: 'prepare' }))!;
  assert.ok(lease);
  const route = frozenRoute(eventId);
  await updateLeasedIngress(f.db, lease,
    "target_json=?,mode='engaged',instance_id=?,tracker_event_id=?,effects_complete=1,ack_state='skipped'",
    [JSON.stringify(route), route.instanceId!, route.deliveryEventId], 100);
  f.sql.prepare(
    'INSERT INTO slack_reply_trackers(instance_id,event_id,target_json,persona_json,publish,created_at,updated_at) VALUES(?,?,?,?,?,100,100)',
  ).run(route.instanceId!, route.deliveryEventId, JSON.stringify(route.target), route.persona ? JSON.stringify(route.persona) : null, 1);
  return lease;
}

async function readyFixture(eventId = 'E1', id = 'I1') {
  const f = ingressDbFixture();
  try {
    const lease = await seedPreparing(f, eventId, id);
    assert.equal(await storeFrozenRequest(f.db, lease, nativeRequest(eventId), 100), true);
    return { f, route: frozenRoute(eventId), request: nativeRequest(eventId) };
  } catch (error) {
    f.dispose();
    throw error;
  }
}

function releasedDue(f: ReturnType<typeof ingressDbFixture>, id = 'I1', now = 200): void {
  f.sql.prepare('UPDATE slack_ingress SET lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=? WHERE id=?').run(0, id);
  assert.ok(now >= 0);
}

test('a ready frozen ingress skips preparation and hands off exactly once', async () => {
  const { f, request } = await readyFixture();
  try {
    let prepareCalls = 0;
    const dispatched: AgentDispatchRequest[] = [];
    const result = await recoverSlackIngress({ DB: f.db }, { now: 100, ingressId: 'I1' }, {
      prepare: async () => { prepareCalls++; throw new Error('prepare must not run'); },
      dispatch: async value => { dispatched.push(value); return receipt; },
    });

    assert.deepEqual(result, { processed: 1, remaining: 0 });
    assert.equal(prepareCalls, 0);
    assert.deepEqual(dispatched, [request]);
    const row = (await readSlackIngress(f.db, 'I1'))!;
    assert.equal(row.state, 'accepted');
    assert.deepEqual(JSON.parse(row.receipt_json!), receipt);
    assert.equal(f.count('cutover_producers'), 0);
    assert.equal(f.sql.prepare('SELECT submission_id FROM slack_reply_trackers').get()?.submission_id, 'S');
  } finally {
    f.dispose();
  }
});

test('lost native admission response replays the same request, key, and receipt once', async () => {
  const { f, request } = await readyFixture();
  try {
    const dispatched: AgentDispatchRequest[] = [];
    const admitted = new Map<string, DispatchReceipt>();
    let admissions = 0;
    const dispatch = async (value: AgentDispatchRequest): Promise<DispatchReceipt> => {
      dispatched.push(value);
      const key = value.idempotencyKey!;
      const existing = admitted.get(key);
      if (existing) return existing;
      admissions++;
      admitted.set(key, receipt);
      throw new Error('native admission response lost after durable admission');
    };

    const first = await recoverSlackIngress({ DB: f.db }, { now: 100, ingressId: 'I1' }, { prepare: async () => { throw new Error('ready row'); }, dispatch });
    assert.deepEqual(first, { processed: 1, remaining: 1 });
    const deferred = (await readSlackIngress(f.db, 'I1'))!;
    assert.equal(deferred.state, 'uncertain');
    assert.equal(deferred.failure_category, 'native-uncertain');
    releasedDue(f);

    const second = await recoverSlackIngress({ DB: f.db }, { now: 200, ingressId: 'I1' }, { prepare: async () => { throw new Error('ready row'); }, dispatch });
    assert.deepEqual(second, { processed: 1, remaining: 0 });
    assert.equal(admissions, 1);
    assert.equal(dispatched.length, 2);
    assert.deepEqual(dispatched[0], request);
    assert.deepEqual(dispatched[1], request);
    assert.equal(dispatched[0].idempotencyKey, 'slack:T:E1');
    assert.equal(dispatched[1].idempotencyKey, dispatched[0].idempotencyKey);
    const row = (await readSlackIngress(f.db, 'I1'))!;
    assert.equal(row.state, 'accepted');
    assert.deepEqual(JSON.parse(row.receipt_json!), receipt);
  } finally {
    f.dispose();
  }
});

test('unfrozen context is chosen once, then a frozen retry ignores newer binding context', async () => {
  const f = ingressDbFixture();
  try {
    await insertBinding(f.db, 'P');
    await acceptSlackIngress(f.db, verifiedEvent(), { id: 'I1', now: 100 });
    const prepared: ProjectDispatchRequest[] = [];
    const dispatched: AgentDispatchRequest[] = [];
    const first = await recoverSlackIngress({ DB: f.db }, { now: 100, ingressId: 'I1' }, {
      prepare: async (_env, request) => { prepared.push(request); return preparedRequest(request); },
      dispatch: async value => { dispatched.push(value); throw new Error('native response lost'); },
    });
    assert.equal(first.processed, 1);
    assert.equal(prepared.length, 1);
    assert.ok(prepared[0].id.includes(':P:'));
    const frozen = (await readSlackIngress(f.db, 'I1'))!;
    assert.equal(JSON.parse(frozen.target_json!).target.projectId, 'P');

    f.sql.prepare('UPDATE bindings SET project_id=? WHERE project_id=?').run('Q', 'P');
    releasedDue(f);
    await recoverSlackIngress({ DB: f.db }, { now: 200, ingressId: 'I1' }, {
      prepare: async (_env, request) => { prepared.push(request); return preparedRequest(request); },
      dispatch: async value => { dispatched.push(value); return receipt; },
    });
    assert.equal(prepared.length, 1, 'frozen handoff must not re-read current context');
    assert.ok(dispatched[1].id.includes(':P:'), 'frozen retry keeps the old project');

    await acceptSlackIngress(f.db, verifiedEvent('E2'), { id: 'I2', now: 201 });
    await recoverSlackIngress({ DB: f.db }, { now: 202, ingressId: 'I2' }, {
      prepare: async (_env, request) => { prepared.push(request); return preparedRequest(request); },
      dispatch: async value => { dispatched.push(value); return receipt; },
    });
    assert.equal(prepared.length, 2);
    assert.ok(prepared[1].id.includes(':Q:'), 'a new unfrozen event may choose the new context');
    assert.equal((await readSlackIngress(f.db, 'I2'))!.state, 'accepted');
  } finally {
    f.dispose();
  }
});

test('the closed intake fence is a backstop for retries, not a recovery gate', async () => {
  const { f } = await readyFixture();
  try {
    f.closeIntake();
    assert.deepEqual(await acceptSlackIngress(f.db, verifiedEvent(), { id: 'duplicate' }),
      { status: 'accepted', id: 'I1', duplicate: true });
    const result = await recoverSlackIngress({ DB: f.db }, { now: 100, ingressId: 'I1' }, {
      prepare: async () => { throw new Error('prepare must not run'); },
      dispatch: async () => receipt,
    });
    assert.deepEqual(result, { processed: 1, remaining: 0 });
    assert.equal(f.count('slack_ingress'), 1);
    assert.equal((await readSlackIngress(f.db, 'I1'))!.state, 'accepted');
  } finally {
    f.dispose();
  }
});

test('a stale successful native response cannot mutate a competing lease, and a fresh claim repairs', async () => {
  const { f } = await readyFixture();
  try {
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = recoverSlackIngress({ DB: f.db }, { now: 100, ingressId: 'I1' }, {
      prepare: async () => { throw new Error('prepare must not run'); },
      dispatch: async value => {
        started = true;
        await gate;
        assert.equal(value.idempotencyKey, 'slack:T:E1');
        return receipt;
      },
    });
    for (let i = 0; i < 30 && !started; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(started);
    f.sql.prepare("UPDATE slack_ingress SET revision=revision+1,lease_owner='B' WHERE id='I1'").run();
    release();
    assert.deepEqual(await pending, { processed: 1, remaining: 1 });

    const raced = (await readSlackIngress(f.db, 'I1'))!;
    assert.equal(raced.lease_owner, 'B');
    assert.equal(raced.state, 'ready');
    assert.equal(f.sql.prepare('SELECT submission_id FROM slack_reply_trackers').get()?.submission_id, null);
    assert.equal(f.count('cutover_producers'), 1);

    releasedDue(f);
    assert.deepEqual(await recoverSlackIngress({ DB: f.db }, { now: 200, ingressId: 'I1' }, {
      prepare: async () => { throw new Error('prepare must not run'); },
      dispatch: async () => receipt,
    }), { processed: 1, remaining: 0 });
    assert.equal((await readSlackIngress(f.db, 'I1'))!.state, 'accepted');
    assert.equal(f.count('cutover_producers'), 0);
  } finally {
    f.dispose();
  }
});

test('lost tracker completion response exposes the committed accepted state without another dispatch', async () => {
  const { f } = await readyFixture();
  try {
    let dispatches = 0;
    f.loseNextCommitResponse();
    const first = await recoverSlackIngress({ DB: f.db }, { now: 100, ingressId: 'I1' }, {
      prepare: async () => { throw new Error('prepare must not run'); },
      dispatch: async () => { dispatches++; return receipt; },
    });
    assert.equal(first.processed, 1);
    const row = (await readSlackIngress(f.db, 'I1'))!;
    assert.equal(row.state, 'accepted');
    assert.deepEqual(JSON.parse(row.receipt_json!), receipt);
    assert.equal(f.sql.prepare('SELECT submission_id FROM slack_reply_trackers').get()?.submission_id, 'S');
    assert.equal(f.count('cutover_producers'), 0);

    assert.deepEqual(await recoverSlackIngress({ DB: f.db }, { now: 200, ingressId: 'I1' }, {
      prepare: async () => { throw new Error('prepare must not run'); },
      dispatch: async () => { dispatches++; return receipt; },
    }), { processed: 0, remaining: 0 });
    assert.equal(dispatches, 1);
  } finally {
    f.dispose();
  }
});

test('corrupt frozen storage fails without a native call and retains the producer', async () => {
  const { f } = await readyFixture();
  try {
    const triggers = f.sql.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('slack_ingress','slack_ingress_manifests','slack_ingress_chunks')",
    ).all() as Array<{ name: string }>;
    for (const trigger of triggers) f.sql.exec('DROP TRIGGER ' + trigger.name);
    f.sql.exec('DELETE FROM slack_ingress_chunks');
    let dispatches = 0;
    const result = await recoverSlackIngress({ DB: f.db }, { now: 100, ingressId: 'I1' }, {
      prepare: async () => { throw new Error('prepare must not run'); },
      dispatch: async () => { dispatches++; return receipt; },
    });

    assert.equal(result.processed, 1);
    assert.equal(result.remaining, 1);
    assert.equal(dispatches, 0);
    const row = (await readSlackIngress(f.db, 'I1'))!;
    assert.equal(row.state, 'failed');
    assert.equal(row.failure_category, 'storage-invalid');
    assert.equal(f.count('cutover_producers'), 1);
    assert.equal(f.sql.prepare('SELECT submission_id FROM slack_reply_trackers').get()?.submission_id, null);
  } finally {
    f.dispose();
  }
});

test('attempt-capped old work stays retained while a due newer ingress is fair to resume', async () => {
  const f = ingressDbFixture();
  try {
    const oldLease = await seedPreparing(f, 'E1', 'old');
    assert.equal(await storeFrozenRequest(f.db, oldLease, nativeRequest('E1'), 100), true);
    const newLease = await seedPreparing(f, 'E2', 'new');
    assert.equal(await storeFrozenRequest(f.db, newLease, nativeRequest('E2'), 102), true);
    f.sql.exec("UPDATE slack_ingress SET handoff_attempts=8 WHERE id='old'");

    assert.deepEqual(await listRecoverableSlackIngress(f.db, 200, 8), ['new']);
    const result = await recoverSlackIngress({ DB: f.db }, { now: 200 }, {
      prepare: async () => { throw new Error('ready rows'); },
      dispatch: async value => {
        assert.equal(value.idempotencyKey, 'slack:T:E2');
        return receipt;
      },
    });
    assert.deepEqual(result, { processed: 1, remaining: 1 });
    const old = (await readSlackIngress(f.db, 'old')) as IngressRow;
    assert.equal(old.state, 'ready');
    assert.equal(old.handoff_attempts, 8);
    assert.equal((await readSlackIngress(f.db, 'new'))!.state, 'accepted');
    assert.equal(f.count('cutover_producers'), 1, 'capped work remains diagnosable');
  } finally {
    f.dispose();
  }
});

test('a mid-recovery budget deferral retains work and a fresh invocation resumes it', async () => {
  const f = ingressDbFixture();
  try {
    await insertBinding(f.db, 'P');
    await acceptSlackIngress(f.db, verifiedEvent(), { id: 'I1', now: 100 });
    const budgetEnv = withIngressBudget({ DB: f.db }, 16);
    let dispatches = 0;
    const first = await recoverSlackIngress(budgetEnv, { now: 100, ingressId: 'I1' }, {
      prepare: async (_env, request) => preparedRequest(request),
      dispatch: async () => { dispatches++; return receipt; },
    });

    assert.equal(first.processed, 1);
    assert.equal(dispatches, 0);
    const deferred = (await readSlackIngress(f.db, 'I1'))!;
    assert.notEqual(deferred.state, 'accepted');
    assert.equal(deferred.failure_category, 'budget-deferred');
    assert.equal(f.count('cutover_producers'), 1);
    assert.ok(ingressBudget(budgetEnv.DB)!.used <= 16);

    releasedDue(f);
    assert.deepEqual(await recoverSlackIngress({ DB: f.db }, { now: 200, ingressId: 'I1' }, {
      prepare: async (_env, request) => preparedRequest(request),
      dispatch: async () => { dispatches++; return receipt; },
    }), { processed: 1, remaining: 0 });
    assert.equal(dispatches, 1);
    assert.equal((await readSlackIngress(f.db, 'I1'))!.state, 'accepted');
  } finally {
    f.dispose();
  }
});

test('an invocation already spent by HTTP leaves recovery within fifty and the next invocation resumes', async () => {
  const { f } = await readyFixture();
  try {
    const env = withIngressBudget({ DB: f.db }, 50);
    for (let i = 0; i < 41; i++) await env.DB.prepare('SELECT 1 AS x').bind().first();
    let dispatches = 0;
    const deferred = await recoverSlackIngress(env, { now: 100, ingressId: 'I1' }, {
      prepare: async () => { throw new Error('ready row'); },
      dispatch: async () => { dispatches++; return receipt; },
    });

    assert.deepEqual(deferred, { processed: 0, remaining: 1 });
    assert.equal(dispatches, 0);
    assert.equal(ingressBudget(env.DB)!.used, 42, 'one bounded recovery read is allowed');
    assert.ok(ingressBudget(env.DB)!.used <= 50);
    assert.equal((await readSlackIngress(f.db, 'I1'))!.state, 'ready');

    assert.deepEqual(await recoverSlackIngress({ DB: f.db }, { now: 200, ingressId: 'I1' }, {
      prepare: async () => { throw new Error('ready row'); },
      dispatch: async () => { dispatches++; return receipt; },
    }), { processed: 1, remaining: 0 });
    assert.equal(dispatches, 1);
  } finally {
    f.dispose();
  }
});

test('a twelve-chunk request replays unchanged across fresh bounded invocations while closed', async () => {
  const f = ingressDbFixture();
  try {
    const lease = await seedPreparing(f);
    const request = nativeRequest();
    request.initialData = { ...snapshot, memoryBlock: '' };
    const base = new TextEncoder().encode(JSON.stringify({agent:'project',...request})).length;
    request.initialData = { ...snapshot, memoryBlock:'x'.repeat(11_495_904-base) };
    assert.equal(await storeFrozenRequest(f.db,lease,request,100),true);
    assert.equal(f.count('slack_ingress_chunks'),12);
    f.sql.exec("UPDATE cutover_control SET state='closed',revision=revision+1");
    let calls = 0;
    const deps = { prepare: async () => { throw new Error('frozen replay cannot prepare'); },
      dispatch: async (value: AgentDispatchRequest) => {
        assert.deepEqual(value,request); calls++;
        if (calls===1) throw new Error('unknown native receipt');
        return receipt;
      } };
    const first = withIngressBudget({DB:f.db});
    await recoverSlackIngress(first,{now:100,ingressId:'I1'},deps);
    assert.ok(ingressBudget(first.DB)!.used<=50); assert.equal(f.count('cutover_producers'),1);
    releasedDue(f);
    const second = withIngressBudget({DB:f.db});
    assert.deepEqual(await recoverSlackIngress(second,{now:200,ingressId:'I1'},deps),{processed:1,remaining:0});
    assert.ok(ingressBudget(second.DB)!.used<=50); assert.equal(calls,2);
    assert.equal(f.count('cutover_producers'),0); assert.equal(f.count('slack_ingress_chunks'),12);
  } finally { f.dispose(); }
});
test('fully spent recovery cannot issue another count or represent unknown obligations as zero', async () => {
  const { f } = await readyFixture();
  try {
    const env = withIngressBudget({DB:f.db});
    for (let i=0;i<50;i++) await env.DB.prepare('SELECT 1').bind().first();
    const result = await recoverSlackIngress(env,{now:100});
    assert.equal(result.processed,0); assert.equal(Number.isNaN(result.remaining),true);
    assert.equal(ingressBudget(env.DB)!.used,50); assert.equal(f.count('cutover_producers'),1);
  } finally { f.dispose(); }
});
await run();
