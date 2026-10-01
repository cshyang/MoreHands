// Agent-run event plumbing invariants — run: npx tsx src/agent-runs/events.test.ts
import assert from 'node:assert/strict';
import { createTestRunner, invokeTool } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';
import {
  activateAgentRunRoute,
  createAgentRunEvent,
  createAgentRunNotification,
  createAgentRunRoute,
  disableAgentRunRoute,
  findActiveAgentRunRoute,
} from './events';
import { proposeAgentRouteTool } from './route-tools';

const { test, run } = createTestRunner();

type Row = Record<string, unknown>;

class FakeD1 implements D1Like {
  events: Row[] = [];
  notifications: Row[] = [];
  routes: Row[] = [];
  connections: Row[] = [];

  prepare(query: string) {
    const db = this;
    return {
      bind(...values: unknown[]) {
        return {
          async first<T = Row>(): Promise<T | null> {
            const { results } = await this.all<T>();
            return results[0] ?? null;
          },
          async all<T = Row>(): Promise<{ results: T[] }> {
            if (query.includes('FROM agent_run_events')) {
              if (query.includes('WHERE dedupe_key=?')) {
                const [dedupeKey] = values;
                return { results: db.events.filter((r) => r.dedupe_key === dedupeKey) as T[] };
              }
            }
            if (query.includes('FROM agent_run_notifications')) {
              if (query.includes('WHERE dedupe_key=?')) {
                const [dedupeKey] = values;
                return { results: db.notifications.filter((r) => r.dedupe_key === dedupeKey) as T[] };
              }
            }
            if (query.includes('FROM agent_run_routes')) {
              if (query.includes('WHERE id=?')) {
                const [id] = values;
                return { results: db.routes.filter((r) => r.id === id) as T[] };
              }
              if (query.includes('status=\'active\'')) {
                const [provider, externalKey, triggerType, triggerValue] = values;
                return {
                  results: db.routes
                    .filter(
                      (r) =>
                        r.provider === provider &&
                        r.external_key === externalKey &&
                        r.trigger_type === triggerType &&
                        r.trigger_value === triggerValue &&
                        r.status === 'active',
                    )
                    .sort((a, b) => Number(b.priority ?? 0) - Number(a.priority ?? 0)) as T[],
                };
              }
            }
            if (query.includes('FROM connections')) {
              if (query.includes('WHERE project_id=? AND provider=?')) {
                const [projectId, provider] = values;
                return { results: db.connections.filter((r) => r.project_id === projectId && r.provider === provider && r.status === 'active') as T[] };
              }
            }
            return { results: [] as T[] };
          },
          async run(): Promise<{ meta: { changes: number } }> {
            if (query.startsWith('INSERT INTO agent_run_events')) {
              const [id, projectId, runId, provider, eventType, providerDeliveryId, providerEntityId, dedupeKey, actorType, handling, handlingReason, payloadJson, occurredAt, receivedAt, processedAt, createdAt] = values;
              if (db.events.some((r) => r.dedupe_key === dedupeKey)) return { meta: { changes: 0 } };
              db.events.push({
                id,
                project_id: projectId,
                run_id: runId,
                provider,
                event_type: eventType,
                provider_delivery_id: providerDeliveryId,
                provider_entity_id: providerEntityId,
                dedupe_key: dedupeKey,
                actor_type: actorType,
                handling,
                handling_reason: handlingReason,
                payload_json: payloadJson,
                occurred_at: occurredAt,
                received_at: receivedAt,
                processed_at: processedAt,
                created_at: createdAt,
              });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('INSERT INTO agent_run_notifications')) {
              const [id, projectId, runId, channel, notificationType, dedupeKey, targetRef, status, providerMessageId, error, createdAt, sentAt] = values;
              if (db.notifications.some((r) => r.dedupe_key === dedupeKey)) return { meta: { changes: 0 } };
              db.notifications.push({
                id,
                project_id: projectId,
                run_id: runId,
                channel,
                notification_type: notificationType,
                dedupe_key: dedupeKey,
                target_ref: targetRef,
                status,
                provider_message_id: providerMessageId,
                error,
                created_at: createdAt,
                sent_at: sentAt,
              });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('INSERT INTO agent_run_routes')) {
              const [id, projectId, provider, externalKey, triggerType, triggerValue, githubOwner, githubRepo, baseBranch, kit, runtime, sandboxProvider, priority, status, createdByType, createdBy, reason, createdAt, updatedAt] = values;
              db.routes.push({
                id,
                project_id: projectId,
                provider,
                external_key: externalKey,
                trigger_type: triggerType,
                trigger_value: triggerValue,
                github_owner: githubOwner,
                github_repo: githubRepo,
                base_branch: baseBranch,
                kit,
                runtime,
                sandbox_provider: sandboxProvider,
                priority,
                status,
                created_by_type: createdByType,
                created_by: createdBy,
                reason,
                created_at: createdAt,
                updated_at: updatedAt,
              });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('UPDATE agent_run_routes SET status=\'active\'')) {
              const [activatedBy, activatedAt, updatedAt, id] = values;
              const row = db.routes.find((r) => r.id === id);
              if (!row) return { meta: { changes: 0 } };
              Object.assign(row, { status: 'active', activated_by: activatedBy, activated_at: activatedAt, updated_at: updatedAt });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('UPDATE agent_run_routes SET status=\'disabled\'')) {
              const [disabledBy, disabledAt, updatedAt, id] = values;
              const row = db.routes.find((r) => r.id === id);
              if (!row) return { meta: { changes: 0 } };
              Object.assign(row, { status: 'disabled', disabled_by: disabledBy, disabled_at: disabledAt, updated_at: updatedAt });
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
        };
      },
    };
  }
}

function seq() {
  let n = 0;
  return {
    id: () => `id-${++n}`,
    now: () => 10_000 + n,
  };
}

test('createAgentRunEvent stores boundary receipts and dedupes by dedupe_key', async () => {
  const db = new FakeD1();
  const deps = seq();
  const first = await createAgentRunEvent(
    db,
    {
      projectId: 'P',
      runId: 'run-1',
      provider: 'github',
      eventType: 'github.pull_request.opened',
      providerDeliveryId: 'gh-delivery-1',
      providerEntityId: '987',
      dedupeKey: 'nango-forward:conn_1:github:gh-delivery-1',
      actorType: 'human',
      handling: 'notify',
      handlingReason: 'PR URL matched an active run',
      payload: { action: 'opened' },
      occurredAt: 9000,
    },
    deps,
  );
  const duplicate = await createAgentRunEvent(
    db,
    {
      projectId: 'P',
      provider: 'github',
      eventType: 'github.pull_request.opened',
      dedupeKey: 'nango-forward:conn_1:github:gh-delivery-1',
      actorType: 'human',
      handling: 'record_only',
      payload: {},
    },
    deps,
  );

  assert.equal(first.duplicate, false);
  assert.equal(first.event.providerEntityId, '987');
  assert.equal(first.event.handling, 'notify');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event.id, first.event.id);
  assert.equal(db.events.length, 1);
});

test('createAgentRunNotification dedupes outbound delivery receipts', async () => {
  const db = new FakeD1();
  const deps = seq();
  const first = await createAgentRunNotification(
    db,
    {
      projectId: 'P',
      runId: 'run-1',
      channel: 'slack',
      notificationType: 'pr_opened',
      dedupeKey: 'notify:run-1:pr_opened:slack',
      targetRef: 'T/C/123.456',
      status: 'pending',
    },
    deps,
  );
  const duplicate = await createAgentRunNotification(
    db,
    {
      projectId: 'P',
      runId: 'run-1',
      channel: 'slack',
      notificationType: 'pr_opened',
      dedupeKey: 'notify:run-1:pr_opened:slack',
      targetRef: 'T/C/123.456',
      status: 'sent',
    },
    deps,
  );

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.notification.status, 'pending');
  assert.equal(db.notifications.length, 1);
});

test('route proposals are pending only and active route conflicts are rejected', async () => {
  const db = new FakeD1();
  db.connections.push({ project_id: 'P', provider: 'linear', status: 'active' });
  db.connections.push({ project_id: 'P', provider: 'github', status: 'active', config_json: JSON.stringify({ repo: 'acme/repo' }) });
  const deps = seq();

  const route = await createAgentRunRoute(
    db,
    {
      projectId: 'P',
      provider: 'linear',
      externalKey: 'EDK',
      triggerType: 'state',
      triggerValue: 'Run Agent',
      githubOwner: 'acme',
      githubRepo: 'repo',
      baseBranch: 'main',
      kit: 'coding-default',
      runtime: 'pi',
      sandboxProvider: 'e2b',
      reason: 'EDK team wants Linear state transitions to run the coding agent.',
      createdByType: 'model',
      createdBy: 'agent',
    },
    deps,
  );

  assert.equal(route.status, 'pending');
  assert.equal(route.githubOwner, 'acme');
  await activateAgentRunRoute(db, route.id, 'admin-1', deps);
  const active = await findActiveAgentRunRoute(db, { provider: 'linear', externalKey: 'EDK', triggerType: 'state', triggerValue: 'Run Agent' });
  assert.equal(active?.id, route.id);

  const conflict = await createAgentRunRoute(
    db,
    {
      projectId: 'P',
      provider: 'linear',
      externalKey: 'EDK',
      triggerType: 'state',
      triggerValue: 'Run Agent',
      githubOwner: 'acme',
      githubRepo: 'repo',
      baseBranch: 'main',
      kit: 'coding-default',
      runtime: 'pi',
      sandboxProvider: 'e2b',
      reason: 'duplicate route',
      createdByType: 'admin',
      createdBy: 'admin-1',
    },
    deps,
  );
  await assert.rejects(() => activateAgentRunRoute(db, conflict.id, 'admin-1', deps), /conflicting active route/i);

  await disableAgentRunRoute(db, route.id, 'admin-1', deps);
  await assert.doesNotReject(() => activateAgentRunRoute(db, conflict.id, 'admin-1', deps));
});

test('route proposal refuses unconnected provider and disallowed repo', async () => {
  const db = new FakeD1();
  db.connections.push({ project_id: 'P', provider: 'github', status: 'active', config_json: JSON.stringify({ repo: 'acme/allowed' }) });

  await assert.rejects(
    () =>
      createAgentRunRoute(db, {
        projectId: 'P',
        provider: 'linear',
        externalKey: 'EDK',
        triggerType: 'state',
        triggerValue: 'Run Agent',
        githubOwner: 'acme',
        githubRepo: 'allowed',
        baseBranch: 'main',
        kit: 'coding-default',
        runtime: 'pi',
        sandboxProvider: 'e2b',
        reason: 'missing linear connection',
      }),
    /provider is not connected/i,
  );

  db.connections.push({ project_id: 'P', provider: 'linear', status: 'active' });
  await assert.rejects(
    () =>
      createAgentRunRoute(db, {
        projectId: 'P',
        provider: 'linear',
        externalKey: 'EDK',
        triggerType: 'state',
        triggerValue: 'Run Agent',
        githubOwner: 'acme',
        githubRepo: 'other',
        baseBranch: 'main',
        kit: 'coding-default',
        runtime: 'pi',
        sandboxProvider: 'e2b',
        reason: 'wrong repo',
      }),
    /target repo is not allowed/i,
  );
});

test('route proposal accepts the harness kit and rejects unknown kits', async () => {
  const db = new FakeD1();
  db.connections.push({ project_id: 'P', provider: 'linear', status: 'active' });
  db.connections.push({ project_id: 'P', provider: 'github', status: 'active', config_json: JSON.stringify({ repo: 'acme/repo' }) });
  const deps = seq();

  const base = {
    projectId: 'P',
    provider: 'linear',
    externalKey: 'EDK',
    triggerType: 'state',
    triggerValue: 'Run Agent',
    githubOwner: 'acme',
    githubRepo: 'repo',
    baseBranch: 'main',
    runtime: 'pi',
    sandboxProvider: 'e2b',
    reason: 'delivery kit route',
  };

  const route = await createAgentRunRoute(db, { ...base, kit: 'coding-default' }, deps);
  assert.equal(route.kit, 'coding-default');

  await assert.rejects(
    () => createAgentRunRoute(db, { ...base, kit: 'no-such-kit' }, deps),
    /kit "no-such-kit" is not supported/i,
  );
});

test('route proposal rejects unsupported new runtimes', async () => {
  const db = new FakeD1();
  db.connections.push({ project_id: 'P', provider: 'linear', status: 'active' });
  db.connections.push({ project_id: 'P', provider: 'github', status: 'active', config_json: JSON.stringify({ repo: 'acme/repo' }) });

  await assert.rejects(
    () =>
      createAgentRunRoute(db, {
        projectId: 'P',
        provider: 'linear',
        externalKey: 'EDK',
        triggerType: 'state',
        triggerValue: 'Run Agent',
        githubOwner: 'acme',
        githubRepo: 'repo',
        baseBranch: 'main',
        kit: 'coding-default',
        runtime: 'opencode',
        sandboxProvider: 'e2b',
        reason: 'legacy runtime should be replaced',
      }),
    /runtime "opencode" is not supported/i,
  );
});

test('propose_agent_route tool creates a pending Pi route only', async () => {
  const db = new FakeD1();
  db.connections.push({ project_id: 'P', provider: 'linear', status: 'active' });
  db.connections.push({ project_id: 'P', provider: 'github', status: 'active', config_json: JSON.stringify({ repo: 'acme/repo' }) });

  const tool = proposeAgentRouteTool({ db, projectId: 'P', createdBy: 'project-agent' });
  const output = JSON.parse(
    await invokeTool(tool, {
      provider: 'linear',
      externalKey: 'EDK',
      triggerType: 'state',
      triggerValue: 'Run Agent',
      githubOwner: 'acme',
      githubRepo: 'repo',
      baseBranch: 'main',
      reason: 'Route Linear Run Agent state into the coding runner.',
    }),
  );

  assert.equal(output.status, 'pending');
  assert.equal(output.kit, 'coding-default');
  assert.equal(output.runtime, 'pi');
  assert.equal(output.sandboxProvider, 'e2b');
  assert.equal(db.routes.length, 1);
  assert.equal(db.routes[0].status, 'pending');
  assert.equal(db.routes[0].runtime, 'pi');
  assert.equal(db.routes[0].sandbox_provider, 'e2b');
  assert.equal(await findActiveAgentRunRoute(db, { provider: 'linear', externalKey: 'EDK', triggerType: 'state', triggerValue: 'Run Agent' }), null);
});

test('propose_agent_route with autoActivate: route goes live immediately; conflicts fall back to pending', async () => {
  const db = new FakeD1();
  db.connections.push({ project_id: 'P', provider: 'linear', status: 'active' });
  db.connections.push({ project_id: 'P', provider: 'github', status: 'active', config_json: JSON.stringify({ repo: 'acme/repo' }) });

  const tool = proposeAgentRouteTool({ db, projectId: 'P', autoActivate: true });
  const exec = (args: Record<string, unknown>) => invokeTool(tool, args);
  const base = {
    provider: 'linear', externalKey: 'EDK', triggerType: 'state', triggerValue: 'Run Agent',
    githubOwner: 'acme', githubRepo: 'repo', baseBranch: 'main', reason: 'dogfood route',
  };

  const first = JSON.parse(await exec({ ...base }));
  assert.equal(first.status, 'active', 'auto-activated without the admin step');
  const active = await findActiveAgentRunRoute(db, { provider: 'linear', externalKey: 'EDK', triggerType: 'state', triggerValue: 'Run Agent' });
  assert.equal(active?.id, first.id);

  // Same trigger again → activation conflict → created but pending, proposal does not throw.
  const second = JSON.parse(await exec({ ...base, reason: 'duplicate' }));
  assert.equal(second.status, 'pending');
  assert.match(second.note, /NOT auto-activated/i);
});

await run();
