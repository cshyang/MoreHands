import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import type { AgentDispatchRequest } from '@flue/runtime';
import type { ProjectContext } from '../../agent/context';
import { projectDispatchMessage } from '../../gateway/dispatch-message';
import type { BoundD1Statement, IngressDb, IngressLease, FrozenIngressRoute } from '../ingress-store';
import { ingressDbFixture, verifiedFixture } from './ingress-db';

const instanceId = 'project:P:agent:default@g2/conv:1.0';
export const snapshot: ProjectContext = {
  projectId: 'P', slug: 'default',
  binding: { projectId: 'P', provider: 'slack', externalAccountId: 'T', externalSpaceId: 'C',
    transportTokenRef: 'SLACK_BOT_TOKEN', transportBotId: 'B', sandboxMode: 'virtual', status: 'active', model: 'zai/glm-5.3-flash' },
  persona: null, catalog: [], personality: '世界🙂', memoryBlock: null,
  connections: { specs: [], enabledIntegrations: [] },
};
export const route: FrozenIngressRoute = {
  mode: 'overhear', deliveryEventId: 'T:E1', epoch: 0, instanceId,
  target: { projectId: 'P', agentSlug: 'default', conversationId: '1.0', provider: 'slack',
    externalAccountId: 'T', externalSpaceId: 'C', externalConversationId: '1.0', transportTokenRef: 'SLACK_BOT_TOKEN' },
  binding: snapshot.binding, persona: null, skipAck: true, overhearNow: '2026-10-04T00:00:00.000Z',
};

export function textRequest(): AgentDispatchRequest {
  return { id: instanceId,
    message: projectDispatchMessage(instanceId, { message: '世界🙂 é', conversationId: '1.0' }, snapshot, 'T:E1'),
    initialData: snapshot, idempotencyKey: 'slack:T:E1' };
}

export function largeImageRequest(): AgentDispatchRequest {
  const input = { message: '世界🙂 é', conversationId: '1.0' };
  return { id: instanceId, message: projectDispatchMessage(instanceId, input, snapshot, 'T:E1', [
    { data: largePng(17).toString('base64'), mimeType: 'image/png', filename: '一.png', fileId: 'F1' },
    { data: largePng(29).toString('base64'), mimeType: 'image/png', filename: '二.png', fileId: 'F2' },
  ]), initialData: snapshot, idempotencyKey: 'slack:T:E1' };
}

function pngChunk(type: string, data: Uint8Array) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0); chunk.write(type, 4, 'ascii'); chunk.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < chunk.length - 4; i++) {
    crc ^= chunk[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

function largePng(pixel: number) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const ihdr = pngChunk('IHDR', header);
  const idat = pngChunk('IDAT', deflateSync(Buffer.from([0, pixel, pixel, pixel, 255])));
  const iend = pngChunk('IEND', Buffer.alloc(0));
  // Valid uncompressed ancillary text pads a real one-pixel RGBA image to exactly 4 MB.
  const padding = Buffer.alloc(4_000_000 - signature.length - ihdr.length - idat.length - iend.length - 12, 65 + pixel % 26);
  Buffer.from([102, 105, 120, 116, 117, 114, 101, 0]).copy(padding);
  return Buffer.concat([signature, ihdr, pngChunk('tEXt', padding), idat, iend]);
}

export function paddedRequest(envelopeBytes = 11_500_000 - 4096): AgentDispatchRequest {
  const request = textRequest();
  request.initialData = { ...snapshot, memoryBlock: '' };
  const base = new TextEncoder().encode(JSON.stringify({ agent: 'project', ...request })).length;
  request.initialData = { ...snapshot, memoryBlock: 'x'.repeat(envelopeBytes - base) };
  return request;
}

export async function preparingIngressFixture() {
  const f = ingressDbFixture();
  try {
    const now = 10_000;
    const event = verifiedFixture();
    f.sql.prepare('INSERT INTO slack_ingress(id,team_id,event_id,digest,event_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('I1', event.teamId, event.eventId, event.digest, event.eventJson, now, now);
    const lease: IngressLease = { id: 'I1', owner: 'A', revision: 1, expiresAt: now + 60_000, phase: 'prepare' };
    f.sql.prepare("UPDATE slack_ingress SET state='preparing',lease_owner=?,revision=?,lease_expires_at=?,prepare_attempts=1 WHERE id='I1'")
      .run(lease.owner, lease.revision, lease.expiresAt);
    f.sql.prepare(
      "UPDATE slack_ingress SET target_json=?,mode='overhear',instance_id=?,tracker_event_id='T:E1',effects_complete=1,ack_state='skipped' WHERE id='I1'"
    ).run(JSON.stringify(route), instanceId);
    return { ...f, now, lease,
      maxBlobBytes: () => Number(f.sql.prepare('SELECT COALESCE(MAX(length(bytes)),0) AS n FROM slack_ingress_chunks').get()!.n),
      chunkCount: () => f.count('slack_ingress_chunks'),
      expireAndReclaim: async () => {
        const nextNow = lease.expiresAt + 1;
        const next: IngressLease = { ...lease, owner: 'B', revision: lease.revision + 1, expiresAt: nextNow + 60_000 };
        f.sql.prepare("UPDATE slack_ingress SET lease_owner=?,revision=?,lease_expires_at=?,prepare_attempts=prepare_attempts+1 WHERE id=?")
          .run(next.owner, next.revision, next.expiresAt, next.id);
        return { lease: next, now: nextNow };
      },
    };
  } catch (error) { f.dispose(); throw error; }
}

export type DbHook = (query: string, values: unknown[], result: unknown) => Promise<unknown> | unknown;
// Preserve actual SQL execution and keep batch statements in the underlying fixture's registry.
export function interceptDb(db: IngressDb, hook: DbHook): IngressDb {
  const bound = new WeakMap<object, { statement: BoundD1Statement; query: string; values: unknown[] }>();
  return {
    prepare: query => ({ bind: (...values) => {
      const statement = db.prepare(query).bind(...values);
      const wrapped = {
        run: async () => hook(query, values, await statement.run()),
        first: async <T>() => await hook(query, values, await statement.first<T>()) as T | null,
        all: async <T>() => await hook(query, values, await statement.all<T>()) as { results: T[] },
      };
      bound.set(wrapped, { statement, query, values });
      return wrapped;
    } }),
    batch: async statements => {
      const result = await db.batch(statements.map(statement => bound.get(statement)?.statement ?? statement));
      for (let i = 0; i < statements.length; i++) {
        const entry = bound.get(statements[i]);
        if (entry) result[i] = await hook(entry.query, entry.values, result[i]) as typeof result[number];
      }
      return result;
    },
  };
}

export function removeFixtureGuards(f: Awaited<ReturnType<typeof preparingIngressFixture>>) {
  const triggers = f.sql.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('slack_ingress','slack_ingress_manifests','slack_ingress_chunks')"
  ).all();
  for (const trigger of triggers) {
    assert.match(String(trigger.name), /^[a-z_]+$/);
    f.sql.exec('DROP TRIGGER ' + trigger.name);
  }
}

export function fixedIngressClock(): () => void {
  const originalNow = Date.now;
  const originalPerformanceNow = Object.getOwnPropertyDescriptor(performance, 'now');
  Date.now = () => 1_000_000;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => 0 });
  return () => {
    Date.now = originalNow;
    if (originalPerformanceNow) Object.defineProperty(performance, 'now', originalPerformanceNow);
    else Reflect.deleteProperty(performance, 'now');
  };
}
