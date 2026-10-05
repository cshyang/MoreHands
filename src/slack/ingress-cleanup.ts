import { withIngressBudget, remainingIngressBudget } from './ingress-budget';
import type { IngressDb } from './ingress-store';
import { FrozenRequestInvalid, checkedFrozenChunkBytes, frozenBytesDigest, ingressAttemptClock, validateFrozenManifest, type FrozenRequestManifest } from './frozen-request';

const GRACE_MS = 24 * 60 * 60 * 1000;
const CHUNK_BYTES = 1_000_000;
interface Candidate extends FrozenRequestManifest {
  current_ingress_id: string | null; state: string | null; revision: number | null;
  lease_owner: string | null; lease_expires_at: number | null; manifest_id: string | null; references: number;
}
interface ChunkMetadata { ordinal: number; byte_length: number; digest: string }
interface CheckedCandidate { candidate: Candidate; chunks: ChunkMetadata[] }

function retainedDiagnostic(reason: string): void {
  // No event, request content or credential values enter cleanup diagnostics.
  console.warn('[ingress-cleanup] retained attempt: ' + reason);
}

function retentionReason(candidate: Candidate, now: number): string | null {
  try { validateFrozenManifest(candidate); }
  catch (error) {
    if (!(error instanceof FrozenRequestInvalid)) throw error;
    return 'invalid manifest metadata';
  }
  if (candidate.current_ingress_id !== candidate.ingress_id) return 'missing or mismatched ingress';
  if (!['received', 'preparing', 'ready', 'uncertain', 'accepted', 'failed'].includes(candidate.state ?? '')
    || !Number.isSafeInteger(candidate.revision) || candidate.revision! < candidate.preparation_revision
    || !Number.isSafeInteger(candidate.references) || candidate.references < 0
    || (candidate.lease_owner === null) !== (candidate.lease_expires_at === null)
    || (candidate.lease_owner !== null && (!candidate.lease_owner || !Number.isSafeInteger(candidate.lease_expires_at)
      || candidate.lease_expires_at! < 0))) {
    return 'invalid ingress ownership metadata';
  }
  if (candidate.references > 0) return 'referenced request';
  if (candidate.state === 'failed') return 'failed ingress';
  if (candidate.created_at > now - GRACE_MS) return 'grace period';
  if (candidate.revision === candidate.preparation_revision && candidate.lease_owner !== null) {
    if (candidate.lease_owner !== candidate.preparation_owner) return 'preparation ownership mismatch';
    if (candidate.lease_expires_at! > now) return 'live preparation lease';
  }
  return null;
}

async function checkChunks(db: IngressDb, candidate: Candidate): Promise<ChunkMetadata[]> {
  const { results } = await db.prepare(
    'SELECT ordinal,length(bytes) AS byte_length,digest FROM slack_ingress_chunks WHERE manifest_id=? ORDER BY ordinal LIMIT 13'
  ).bind(candidate.id).all<ChunkMetadata>();
  if (!Array.isArray(results) || results.length > candidate.chunk_count) throw new FrozenRequestInvalid('Invalid attempt chunk count');
  // A crash may leave a contiguous prefix, including zero chunks. Any other shape is diagnostic.
  const buffer = results.length === candidate.chunk_count ? new Uint8Array(candidate.total_bytes) : null;
  let offset = 0;
  for (let index = 0; index < results.length; index++) {
    const chunk = results[index];
    if (chunk.ordinal !== index || !Number.isSafeInteger(chunk.byte_length) || chunk.byte_length <= 0
      || chunk.byte_length > CHUNK_BYTES || offset + chunk.byte_length > candidate.total_bytes || typeof chunk.digest !== 'string'
      || !/^[a-f0-9]{64}$/.test(chunk.digest)) throw new FrozenRequestInvalid('Invalid attempt chunk metadata');
    // Read and release one platform byte array at a time, including on incomplete attempts.
    await checkChunk(db, candidate.id, chunk, buffer, offset);
    offset += chunk.byte_length;
  }
  const remainingChunks = candidate.chunk_count - results.length;
  if ((buffer && offset !== candidate.total_bytes) || offset > candidate.total_bytes - remainingChunks
    || candidate.total_bytes - offset > remainingChunks * CHUNK_BYTES) {
    throw new FrozenRequestInvalid('Invalid attempt byte length');
  }
  if (buffer && await frozenBytesDigest(buffer) !== candidate.digest) throw new FrozenRequestInvalid('Attempt whole digest mismatch');
  return results;
}

async function checkChunk(db: IngressDb, manifestId: string, metadata: ChunkMetadata, buffer: Uint8Array | null, offset: number): Promise<void> {
  const row = await db.prepare('SELECT ordinal,bytes,digest FROM slack_ingress_chunks WHERE manifest_id=? AND ordinal=?')
    .bind(manifestId, metadata.ordinal).first<{ ordinal: number; bytes: unknown; digest: string }>();
  if (!row || row.ordinal !== metadata.ordinal || row.digest !== metadata.digest) throw new FrozenRequestInvalid('Attempt changed during readback');
  const bytes = checkedFrozenChunkBytes(row.bytes);
  if (bytes.length !== metadata.byte_length || await frozenBytesDigest(bytes) !== metadata.digest) throw new FrozenRequestInvalid('Attempt chunk digest mismatch');
  if (buffer) buffer.set(bytes, offset);
}

function deletionGuard(candidate: Candidate, now: number): { sql: string; values: unknown[] } {
  return {
    sql: 'SELECT 1 FROM slack_ingress_manifests m JOIN slack_ingress i ON i.id=m.ingress_id '
      + 'WHERE m.id=? AND m.ingress_id=? AND m.encoding_version=? AND m.total_bytes=? AND m.chunk_count=? AND m.digest=? '
      + 'AND m.created_at=? AND m.preparation_owner=? AND m.preparation_revision=? AND m.created_at<=? '
      + "AND i.state=? AND i.state<>'failed' AND i.revision=? AND i.lease_owner IS ? AND i.lease_expires_at IS ? AND i.manifest_id IS ? "
      + 'AND i.revision>=m.preparation_revision '
      + 'AND (i.revision>m.preparation_revision OR i.lease_owner IS NULL OR (i.lease_owner=m.preparation_owner AND i.lease_expires_at<=?)) '
      + 'AND NOT EXISTS(SELECT 1 FROM slack_ingress referenced WHERE referenced.manifest_id=m.id)',
    values: [candidate.id, candidate.ingress_id, candidate.encoding_version, candidate.total_bytes, candidate.chunk_count, candidate.digest,
      candidate.created_at, candidate.preparation_owner, candidate.preparation_revision, now - GRACE_MS,
      candidate.state, candidate.revision, candidate.lease_owner, candidate.lease_expires_at, candidate.manifest_id, now],
  };
}

function chunkSetGuard(chunks: ChunkMetadata[], manifestId: string): { sql: string; values: unknown[] } {
  const values: unknown[] = [manifestId, chunks.length];
  let sql = '(SELECT COUNT(*) FROM slack_ingress_chunks c WHERE c.manifest_id=?)=?';
  for (const chunk of chunks) {
    sql += ' AND EXISTS(SELECT 1 FROM slack_ingress_chunks c WHERE c.manifest_id=? AND c.ordinal=? AND length(c.bytes)=? AND c.digest=?)';
    values.push(manifestId, chunk.ordinal, chunk.byte_length, chunk.digest);
  }
  return { sql, values };
}

async function remainingAttempt(db: IngressDb, candidate: Candidate): Promise<{ manifest_count: number; chunk_count: number }> {
  const result = await db.prepare(
    'SELECT (SELECT COUNT(*) FROM slack_ingress_manifests WHERE id=?) AS manifest_count,'
    + '(SELECT COUNT(*) FROM slack_ingress_chunks WHERE manifest_id=?) AS chunk_count'
  ).bind(candidate.id, candidate.id).first<{ manifest_count: number; chunk_count: number }>();
  if (!result || !Number.isSafeInteger(result.manifest_count) || result.manifest_count < 0 || result.manifest_count > 1
    || !Number.isSafeInteger(result.chunk_count) || result.chunk_count < 0 || result.chunk_count > 12) {
    throw new Error('Unavailable cleanup readback');
  }
  return result;
}

export async function cleanupUnreferencedIngressAttempts(db: IngressDb,
  options: { now: number; limit: number }): Promise<{ deleted: number; retained: number }> {
  db = withIngressBudget({ DB: db }).DB;
  const clock = ingressAttemptClock(options.now);
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) throw new Error('Invalid ingress cleanup limit');
  const limit = Math.min(options.limit, 8);
  const { results: candidates } = await db.prepare(
    'SELECT m.*,i.id AS current_ingress_id,i.state,i.revision,i.lease_owner,i.lease_expires_at,i.manifest_id,'
    + '(SELECT COUNT(*) FROM slack_ingress referenced WHERE referenced.manifest_id=m.id) AS "references" '
    + 'FROM slack_ingress_manifests m LEFT JOIN slack_ingress i ON i.id=m.ingress_id '
    + "WHERE (typeof(m.created_at)<>'integer' OR m.created_at<0 OR m.created_at<=?) "
    + "ORDER BY (\"references\"=0 AND i.state IS NOT 'failed') DESC,m.created_at,m.id LIMIT ?"
  ).bind(clock() - GRACE_MS, limit).all<Candidate>();
  if (!Array.isArray(candidates) || candidates.length > limit) throw new Error('Invalid cleanup candidate result');
  let retained = 0;
  const checked: CheckedCandidate[] = [];
  for (const candidate of candidates) {
    const reason = retentionReason(candidate, clock());
    if (reason) { retained++; retainedDiagnostic(reason); continue; }
    // Reserve the entire candidate, including deletion and readback, before any BLOB read.
    // Each already checked attempt still needs two batch statements and one primary read.
    if (remainingIngressBudget(db) - checked.length * 3 < candidate.chunk_count + 4) {
      retained++; retainedDiagnostic('invocation budget'); continue;
    }
    let chunks: ChunkMetadata[];
    try { chunks = await checkChunks(db, candidate); }
    catch (error) {
      // Integrity failures retain diagnostics. Database failures remain unavailable, not a clean result.
      if (!(error instanceof FrozenRequestInvalid)) throw error;
      retained++; retainedDiagnostic('corrupt or changed chunks'); continue;
    }
    checked.push({ candidate, chunks });
  }
  if (!checked.length) return { deleted: 0, retained };
  const statements: Parameters<IngressDb['batch']>[0] = [];
  for (const { candidate, chunks } of checked) {
    const guard = deletionGuard(candidate, clock());
    const chunkGuard = chunkSetGuard(chunks, candidate.id);
    statements.push(db.prepare(
      'DELETE FROM slack_ingress_chunks WHERE manifest_id=? AND EXISTS(' + guard.sql + ') AND ' + chunkGuard.sql + ' RETURNING ordinal'
    ).bind(candidate.id, ...guard.values, ...chunkGuard.values));
    statements.push(db.prepare(
      'DELETE FROM slack_ingress_manifests WHERE id=? AND EXISTS(' + guard.sql + ') '
      + 'AND NOT EXISTS(SELECT 1 FROM slack_ingress_chunks c WHERE c.manifest_id=slack_ingress_manifests.id) RETURNING id'
    ).bind(candidate.id, ...guard.values));
  }
  let batchResults: Awaited<ReturnType<IngressDb['batch']>>;
  try { batchResults = await db.batch(statements); }
  catch (error) {
    // Response loss is positive only when BOTH objects are gone. A present manifest with
    // missing chunks must never become a false clean result or silently reused candidate.
    for (const { candidate } of checked) {
      const remaining = await remainingAttempt(db, candidate);
      if (remaining.manifest_count !== 0 || remaining.chunk_count !== 0) throw error;
    }
    return { deleted: checked.length, retained };
  }
  if (!Array.isArray(batchResults) || batchResults.length !== statements.length) throw new Error('Invalid cleanup batch result');
  let deleted = 0;
  for (let index = 0; index < checked.length; index++) {
    const { candidate, chunks } = checked[index];
    const chunkResult = batchResults[index * 2], manifestResult = batchResults[index * 2 + 1];
    if (!chunkResult?.success || !manifestResult?.success || !Array.isArray(chunkResult.results) || !Array.isArray(manifestResult.results)
      || (chunkResult.results.length !== 0 && chunkResult.results.length !== chunks.length) || manifestResult.results.length > 1) {
      throw new Error('Invalid cleanup deletion counts');
    }
    const remaining = await remainingAttempt(db, candidate);
    if (manifestResult.results.length === 1) {
      if (chunkResult.results.length !== chunks.length || remaining.manifest_count !== 0 || remaining.chunk_count !== 0) {
        throw new Error('Incomplete ingress attempt deletion');
      }
      deleted++;
    } else {
      if (chunkResult.results.length !== 0 || remaining.manifest_count !== 1 || remaining.chunk_count !== chunks.length) {
        throw new Error('Ingress cleanup left a partial attempt');
      }
      retained++; retainedDiagnostic('deletion guard changed');
    }
  }
  return { deleted, retained };
}
