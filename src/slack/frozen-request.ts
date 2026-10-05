import type { AgentDispatchRequest } from '@flue/runtime';
import type { IngressDb, IngressLease } from './ingress-store';

const CHUNK_BYTES = 1_000_000;
const MAX_CHUNKS = 12;
const MAX_ENVELOPE_BYTES = 11_500_000 - 4096;
const encoder = new TextEncoder();
// The request schema excludes agent. Adding it to the root object adds exactly this prefix.
const ENVELOPE_OVERHEAD = encoder.encode('{"agent":"project",').length - 1;
const SHA256 = /^[a-f0-9]{64}$/;

/** Payload validation only. Database/crypto availability errors retain their original identity. */
export class FrozenRequestInvalid extends Error {
  constructor(message: string) { super(message); this.name = 'FrozenRequestInvalid'; }
}

export interface FrozenRequestManifest {
  id: string; ingress_id: string; encoding_version: number; total_bytes: number; chunk_count: number;
  digest: string; created_at: number; preparation_owner: string; preparation_revision: number;
}

export function validateFrozenManifest(manifest: FrozenRequestManifest): void {
  if (!manifest || typeof manifest.id !== 'string' || !manifest.id || typeof manifest.ingress_id !== 'string'
    || !manifest.ingress_id || manifest.encoding_version !== 1
    || !Number.isSafeInteger(manifest.total_bytes) || manifest.total_bytes <= 0 || manifest.total_bytes > MAX_ENVELOPE_BYTES
    || !Number.isSafeInteger(manifest.chunk_count) || manifest.chunk_count <= 0 || manifest.chunk_count > MAX_CHUNKS
    || manifest.total_bytes < manifest.chunk_count || manifest.total_bytes > manifest.chunk_count * CHUNK_BYTES
    || typeof manifest.digest !== 'string' || !SHA256.test(manifest.digest)
    || !Number.isSafeInteger(manifest.created_at) || manifest.created_at < 0
    || typeof manifest.preparation_owner !== 'string' || !manifest.preparation_owner
    || !Number.isSafeInteger(manifest.preparation_revision) || manifest.preparation_revision < 1) {
    throw new FrozenRequestInvalid('Invalid frozen request manifest');
  }
}

// Public now is a deterministic test override. Awaited work still consumes lease time.
export function ingressAttemptClock(now: number): () => number {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid ingress clock');
  const start = Date.now();
  const monotonicStart = performance.now();
  return () => now + Math.floor(Math.max(0, Date.now() - start, performance.now() - monotonicStart));
}

export async function frozenBytesDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function assertJsonSafe(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return;
  if (!value || typeof value !== 'object') throw new FrozenRequestInvalid('Frozen request contains a non-JSON value');
  if (ancestors.has(value)) throw new FrozenRequestInvalid('Frozen request contains a cycle');
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) {
    throw new FrozenRequestInvalid('Frozen request contains an unsupported object');
  }
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) throw new FrozenRequestInvalid('Frozen request contains a sparse or extended array');
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)
      || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) {
      throw new FrozenRequestInvalid('Frozen request contains an unsupported property');
    }
    assertJsonSafe(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}

function assertRequest(value: unknown): asserts value is AgentDispatchRequest {
  assertJsonSafe(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FrozenRequestInvalid('Invalid frozen native request');
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some(key => !['id', 'message', 'initialData', 'uid', 'idempotencyKey'].includes(key))
    || typeof request.id !== 'string' || !request.id
    || ('uid' in request && request.uid !== null && (typeof request.uid !== 'string' || !request.uid))
    || (typeof request.uid === 'string' && 'initialData' in request)
    || ('idempotencyKey' in request && (typeof request.idempotencyKey !== 'string'
      || !request.idempotencyKey || request.idempotencyKey.length > 256))) throw new FrozenRequestInvalid('Invalid frozen native request');
  const message = request.message;
  if (typeof message !== 'string') {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new FrozenRequestInvalid('Invalid frozen native message');
    const m = message as Record<string, unknown>;
    if (typeof m.body !== 'string' || (m.kind !== 'user' && m.kind !== 'signal')) throw new FrozenRequestInvalid('Invalid frozen native message');
    if (m.kind === 'signal') {
      if (typeof m.type !== 'string' || !m.type
        || ('attributes' in m && (!m.attributes || typeof m.attributes !== 'object' || Array.isArray(m.attributes)
          || Object.values(m.attributes).some(value => typeof value !== 'string')))
        || ('tagName' in m && (typeof m.tagName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(m.tagName)))) {
        throw new FrozenRequestInvalid('Invalid frozen native signal');
      }
    } else if ('attachments' in m) {
      if (!Array.isArray(m.attachments)) throw new FrozenRequestInvalid('Invalid frozen native attachments');
      for (const attachment of m.attachments) {
        if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)
          || !['image', 'document'].includes(attachment.type) || typeof attachment.data !== 'string'
          || typeof attachment.mimeType !== 'string' || !attachment.mimeType
          || ('filename' in attachment && typeof attachment.filename !== 'string')) {
          throw new FrozenRequestInvalid('Invalid frozen native attachment');
        }
      }
    }
  }
}

const prepareGuard = "id=? AND state='preparing' AND manifest_id IS NULL AND lease_owner=? AND revision=? AND lease_expires_at>?";
function guardValues(lease: IngressLease, now: number): unknown[] { return [lease.id, lease.owner, lease.revision, now]; }

export async function storeFrozenRequest(db: IngressDb, lease: IngressLease,
  request: AgentDispatchRequest, now: number): Promise<boolean> {
  const clock = ingressAttemptClock(now);
  if (lease.phase !== 'prepare') return false;
  const live = await db.prepare('SELECT id FROM slack_ingress WHERE ' + prepareGuard).bind(...guardValues(lease, clock())).first();
  if (!live) return false;
  assertRequest(request);
  // Freeze once. Whole and per-chunk digests come from these original bytes before any writes.
  const bytes = encoder.encode(JSON.stringify(request));
  if (bytes.length + ENVELOPE_OVERHEAD > MAX_ENVELOPE_BYTES) throw new FrozenRequestInvalid('Frozen request exceeds native envelope bound');
  const digest = await frozenBytesDigest(bytes);
  const chunkCount = Math.ceil(bytes.length / CHUNK_BYTES);
  const chunkDigests: string[] = [];
  for (let ordinal = 0; ordinal < chunkCount; ordinal++) {
    chunkDigests.push(await frozenBytesDigest(bytes.subarray(ordinal * CHUNK_BYTES, Math.min((ordinal + 1) * CHUNK_BYTES, bytes.length))));
  }
  const id = crypto.randomUUID();
  const inserted = await db.prepare(
    'INSERT INTO slack_ingress_manifests(id,ingress_id,encoding_version,total_bytes,chunk_count,digest,created_at,preparation_owner,preparation_revision) '
    + 'SELECT ?,id,1,?,?,?,?,lease_owner,revision FROM slack_ingress WHERE ' + prepareGuard + ' RETURNING id'
  ).bind(id, bytes.length, chunkCount, digest, clock(), ...guardValues(lease, clock())).first<{ id: string }>();
  if (!inserted) return false;
  for (let ordinal = 0; ordinal < chunkCount; ordinal++) {
    const chunk = bytes.subarray(ordinal * CHUNK_BYTES, Math.min((ordinal + 1) * CHUNK_BYTES, bytes.length));
    const written = await db.prepare(
      'INSERT INTO slack_ingress_chunks(manifest_id,ordinal,bytes,digest) '
      + 'SELECT ?,?,?,? FROM slack_ingress WHERE ' + prepareGuard
      + ' AND EXISTS(SELECT 1 FROM slack_ingress_manifests m WHERE m.id=? AND m.ingress_id=slack_ingress.id '
      + 'AND m.preparation_owner=slack_ingress.lease_owner AND m.preparation_revision=slack_ingress.revision) RETURNING ordinal'
    ).bind(id, ordinal, chunk, chunkDigests[ordinal], ...guardValues(lease, clock()), id).first<{ ordinal: number }>();
    if (!written) return false;
  }
  // The real migration's trigger checks completeness, effects and ack in this separate operation.
  let published: { id: string } | null;
  try {
    published = await db.prepare(
      "UPDATE slack_ingress SET manifest_id=?,state='ready',revision=revision+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE "
      + prepareGuard + ' RETURNING id'
    ).bind(id, clock(), ...guardValues(lease, clock())).first<{ id: string }>();
  } catch (error) {
    const winner = await db.prepare('SELECT manifest_id FROM slack_ingress WHERE id=?').bind(lease.id).first<{ manifest_id: string | null }>();
    if (winner?.manifest_id === id) return true;
    if (winner?.manifest_id) return false;
    throw error;
  }
  return published !== null;
}

export function checkedFrozenChunkBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    if (!value.length || value.length > CHUNK_BYTES) throw new FrozenRequestInvalid('Invalid frozen chunk byte length');
    return value;
  }
  if (!Array.isArray(value) || !value.length || value.length > CHUNK_BYTES) throw new FrozenRequestInvalid('Invalid frozen chunk byte array');
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i) || !Number.isInteger(value[i]) || value[i] < 0 || value[i] > 255) {
      throw new FrozenRequestInvalid('Invalid frozen chunk byte');
    }
  }
  return Uint8Array.from(value);
}

async function copyChunk(db: IngressDb, manifest: FrozenRequestManifest, ordinal: number, buffer: Uint8Array, offset: number): Promise<number> {
  const row = await db.prepare('SELECT ordinal,bytes,digest FROM slack_ingress_chunks WHERE manifest_id=? AND ordinal=?')
    .bind(manifest.id, ordinal).first<{ ordinal: number; bytes: unknown; digest: string }>();
  if (!row || row.ordinal !== ordinal || typeof row.digest !== 'string' || !SHA256.test(row.digest)) throw new FrozenRequestInvalid('Missing or invalid frozen request chunk');
  const chunk = checkedFrozenChunkBytes(row.bytes);
  if (offset + chunk.length > manifest.total_bytes || await frozenBytesDigest(chunk) !== row.digest) throw new FrozenRequestInvalid('Frozen request chunk integrity failure');
  buffer.set(chunk, offset);
  return chunk.length;
}

export async function loadFrozenRequest(db: IngressDb, ingressId: string): Promise<AgentDispatchRequest> {
  const manifest = await db.prepare(
    'SELECT m.* FROM slack_ingress i JOIN slack_ingress_manifests m ON m.id=i.manifest_id AND m.ingress_id=i.id WHERE i.id=?'
  ).bind(ingressId).first<FrozenRequestManifest>();
  if (!manifest) throw new FrozenRequestInvalid('No published frozen request');
  validateFrozenManifest(manifest);
  const counts = await db.prepare('SELECT COUNT(*) AS count,MIN(ordinal) AS first,MAX(ordinal) AS last FROM slack_ingress_chunks WHERE manifest_id=?')
    .bind(manifest.id).first<{ count: number; first: number; last: number }>();
  if (!counts || counts.count !== manifest.chunk_count || counts.first !== 0 || counts.last !== manifest.chunk_count - 1) {
    throw new FrozenRequestInvalid('Frozen request chunk count or ordinal mismatch');
  }
  const buffer = new Uint8Array(manifest.total_bytes);
  // Each call releases its platform number array before the next chunk is queried.
  let offset = 0;
  for (let ordinal = 0; ordinal < manifest.chunk_count; ordinal++) offset += await copyChunk(db, manifest, ordinal, buffer, offset);
  if (offset !== manifest.total_bytes) throw new FrozenRequestInvalid('Frozen request byte length mismatch');
  if (await frozenBytesDigest(buffer) !== manifest.digest) throw new FrozenRequestInvalid('Frozen request whole digest mismatch');
  let request: unknown;
  try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)); }
  catch { throw new FrozenRequestInvalid('Invalid frozen request UTF-8 or JSON'); }
  assertRequest(request);
  if (encoder.encode(JSON.stringify({ agent: 'project', ...request })).length > MAX_ENVELOPE_BYTES) {
    throw new FrozenRequestInvalid('Frozen request exceeds native envelope bound');
  }
  return request;
}
