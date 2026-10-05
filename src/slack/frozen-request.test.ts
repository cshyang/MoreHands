import assert from 'node:assert/strict';
import type { AgentDispatchRequest } from '@flue/runtime';
import { createTestRunner } from '../shared/test-utils';
import { FrozenRequestInvalid, loadFrozenRequest, storeFrozenRequest } from './frozen-request';
import { interceptDb, largeImageRequest, paddedRequest, preparingIngressFixture, removeFixtureGuards, textRequest } from './test-utils/frozen-request';
const { test, run } = createTestRunner();

test('Unicode and two 4MB images replay with exact bytes, attachment order and creation data', async () => {
  const f = await preparingIngressFixture();
  try {
    const request = largeImageRequest();
    assert.equal(await storeFrozenRequest(f.db, f.lease, request, f.now), true);
    const restored = await loadFrozenRequest(f.db, f.lease.id);
    assert.deepEqual(restored, request);
    assert.deepEqual(new TextEncoder().encode(JSON.stringify(restored)), new TextEncoder().encode(JSON.stringify(request)));
    assert.ok(f.maxBlobBytes() <= 1_000_000);
    assert.ok(f.chunkCount() <= 12);
    const row = f.sql.prepare('SELECT state,manifest_id,revision,lease_owner,lease_expires_at FROM slack_ingress').get()!;
    assert.equal(row.state, 'ready'); assert.ok(row.manifest_id);
    assert.equal(row.revision, f.lease.revision + 1);
    assert.equal(row.lease_owner, null); assert.equal(row.lease_expires_at, null);
  } finally { f.dispose(); }
});

test('valid padding reaches twelve chunks and the exact native envelope limit', async () => {
  const f = await preparingIngressFixture();
  try {
    const request = paddedRequest();
    assert.equal(new TextEncoder().encode(JSON.stringify({ agent: 'project', ...request })).length + 4096, 11_500_000);
    assert.equal(await storeFrozenRequest(f.db, f.lease, request, f.now), true);
    assert.equal(f.chunkCount(), 12);
    assert.deepEqual(await loadFrozenRequest(f.db, 'I1'), request);
  } finally { f.dispose(); }
});

test('native envelope overhead cannot bypass the bound by one byte', async () => {
  const f = await preparingIngressFixture();
  try {
    await assert.rejects(() => storeFrozenRequest(f.db, f.lease, paddedRequest(11_500_000 - 4096 + 1), f.now));
    assert.equal(f.count('slack_ingress_manifests'), 0); assert.equal(f.chunkCount(), 0);
  } finally { f.dispose(); }
});

test('non-JSON values are rejected before storage instead of being silently changed', async () => {
  const f = await preparingIngressFixture();
  try {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get: () => 'changed' });
    const hidden = Object.defineProperty({}, 'secret', { enumerable: false, value: 'lost' });
    const extraArray = Object.assign(['x'], { extra: 'lost' });
    for (const value of [undefined, () => 1, Symbol('lost'), 1n, NaN, Infinity, -Infinity, -0,
      [undefined], new Array(2), new Date(), new Map(), new Set(), new Uint8Array([1]), cycle, accessor,
      hidden, extraArray, { [Symbol('lost')]: 'x' }, { toJSON: () => 'changed' }]) {
      await assert.rejects(() => storeFrozenRequest(f.db, f.lease, { ...textRequest(), initialData: value }, f.now), FrozenRequestInvalid);
    }
    assert.equal(f.count('slack_ingress_manifests'), 0);
  } finally { f.dispose(); }
});

test('malformed native request shapes fail before writes', async () => {
  const f = await preparingIngressFixture();
  try {
    for (const request of [null, [], {}, { id: '', message: 'x' }, { id: 'x', message: {} },
      { ...textRequest(), agent: 'other' }, { id: 'x', message: 3 }]) {
      await assert.rejects(() => storeFrozenRequest(f.db, f.lease, request as AgentDispatchRequest, f.now));
    }
    assert.equal(f.count('slack_ingress_manifests'), 0);
  } finally { f.dispose(); }
});

test('expired, reclaimed, wrong-phase and stale publishers make no changes', async () => {
  const f = await preparingIngressFixture();
  try {
    assert.equal(await storeFrozenRequest(f.db, { ...f.lease, phase: 'handoff' }, textRequest(), f.now), false);
    const next = await f.expireAndReclaim();
    assert.equal(await storeFrozenRequest(f.db, f.lease, textRequest(), next.now), false);
    assert.equal(f.count('slack_ingress_manifests'), 0);
    assert.equal(await storeFrozenRequest(f.db, next.lease, textRequest(), next.now), true);
    assert.equal(await storeFrozenRequest(f.db, f.lease, { ...textRequest(), message: 'stale' }, next.now), false);
    assert.deepEqual(await loadFrozenRequest(f.db, 'I1'), textRequest());
  } finally { f.dispose(); }
});

test('every chunk write rechecks lease ownership after awaited database work', async () => {
  const f = await preparingIngressFixture();
  try {
    let chunks = 0;
    const db = interceptDb(f.db, (query, _values, result) => {
      if (/INSERT INTO slack_ingress_chunks/.test(query) && ++chunks === 1) {
        f.sql.prepare("UPDATE slack_ingress SET revision=revision+1,lease_owner='B' WHERE id='I1'").run();
      }
      return result;
    });
    assert.equal(await storeFrozenRequest(db, f.lease, paddedRequest(), f.now), false);
    assert.equal(f.chunkCount(), 1);
    assert.equal(f.sql.prepare('SELECT state FROM slack_ingress').get()!.state, 'preparing');
    await assert.rejects(() => loadFrozenRequest(f.db, 'I1'));
  } finally { f.dispose(); }
});

test('clock advances after awaited I/O, fencing expiry without a reclaim', async () => {
  const f = await preparingIngressFixture();
  const originalNow = Date.now;
  try {
    let wall = originalNow(); Date.now = () => wall;
    const db = interceptDb(f.db, (query, _values, result) => {
      if (/INSERT INTO slack_ingress_manifests/.test(query)) wall += 60_001;
      return result;
    });
    assert.equal(await storeFrozenRequest(db, f.lease, textRequest(), f.now), false);
    assert.equal(f.chunkCount(), 0);
  } finally { Date.now = originalNow; f.dispose(); }
});

test('concurrent attempts publish one immutable winner', async () => {
  const f = await preparingIngressFixture();
  try {
    const requests = [textRequest(), { ...textRequest(), message: 'other candidate' }];
    const results = await Promise.all(requests.map(request => storeFrozenRequest(f.db, f.lease, request, f.now)));
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual(await loadFrozenRequest(f.db, 'I1'), requests[results.indexOf(true)]);
  } finally { f.dispose(); }
});

test('publication response loss reads the committed winner from the primary', async () => {
  const f = await preparingIngressFixture();
  try {
    let lost = false;
    const db = interceptDb(f.db, (query, _values, result) => {
      if (/UPDATE slack_ingress SET manifest_id/.test(query) && !lost) { lost = true; throw new Error('lost publication response'); }
      return result;
    });
    assert.equal(await storeFrozenRequest(db, f.lease, textRequest(), f.now), true);
    assert.equal(lost, true);
    assert.deepEqual(await loadFrozenRequest(f.db, 'I1'), textRequest());
    assert.equal(f.count('slack_ingress_manifests'), 1);
  } finally { f.dispose(); }
});

test('publication trigger rejects unchecked effects or acknowledgement and keeps partial attempts invisible', async () => {
  for (const change of ["effects_complete=0", "ack_state='uncertain'"]) {
    const f = await preparingIngressFixture();
    try {
      f.sql.exec('UPDATE slack_ingress SET ' + change);
      await assert.rejects(() => storeFrozenRequest(f.db, f.lease, textRequest(), f.now));
      assert.equal(f.sql.prepare('SELECT state FROM slack_ingress').get()!.state, 'preparing');
      await assert.rejects(() => loadFrozenRequest(f.db, 'I1'), FrozenRequestInvalid);
    } finally { f.dispose(); }
  }
});

test('SQLite typed arrays and checked D1 number arrays both replay identically, one chunk per query', async () => {
  const f = await preparingIngressFixture();
  try {
    const request = paddedRequest();
    assert.equal(await storeFrozenRequest(f.db, f.lease, request, f.now), true);
    let reads = 0;
    const db = interceptDb(f.db, (query, _values, result) => {
      if (/SELECT.*bytes/s.test(query) && /FROM slack_ingress_chunks/.test(query) && result && !('results' in (result as object))) {
        const row = result as { bytes?: unknown };
        if (row.bytes instanceof Uint8Array) { reads++; return { ...row, bytes: Array.from(row.bytes) }; }
      }
      return result;
    });
    assert.deepEqual(await loadFrozenRequest(db, 'I1'), request);
    assert.equal(reads, 12);
  } finally { f.dispose(); }
});

test('invalid platform byte arrays are rejected without coercion', async () => {
  const f = await preparingIngressFixture();
  try {
    assert.equal(await storeFrozenRequest(f.db, f.lease, textRequest(), f.now), true);
    for (const bad of [[256], [-1], [0.5], ['1'], [NaN], new Array(3), {}, new Int8Array([1])]) {
      const db = interceptDb(f.db, (query, _values, result) => {
        if (/FROM slack_ingress_chunks/.test(query) && result && 'bytes' in (result as object)) return { ...result as object, bytes: bad };
        return result;
      });
      await assert.rejects(() => loadFrozenRequest(db, 'I1'));
    }
  } finally { f.dispose(); }
});

test('missing, corrupt, changed ordinals and malformed manifest metadata fail closed', async () => {
  for (const mutation of [
    "DELETE FROM slack_ingress_chunks WHERE ordinal=0",
    "UPDATE slack_ingress_chunks SET bytes=X'00' WHERE ordinal=0",
    "UPDATE slack_ingress_chunks SET digest='bad' WHERE ordinal=0",
    "UPDATE slack_ingress_chunks SET ordinal=11 WHERE ordinal=0",
    "UPDATE slack_ingress_manifests SET digest='bad'",
    "UPDATE slack_ingress_manifests SET total_bytes=total_bytes+1",
    "UPDATE slack_ingress_manifests SET chunk_count=2",
    "UPDATE slack_ingress_manifests SET ingress_id='missing'",
  ]) {
    const f = await preparingIngressFixture();
    try {
      assert.equal(await storeFrozenRequest(f.db, f.lease, textRequest(), f.now), true);
      removeFixtureGuards(f);
      f.sql.exec('PRAGMA foreign_keys=OFF'); f.sql.exec(mutation);
      await assert.rejects(() => loadFrozenRequest(f.db, 'I1'), FrozenRequestInvalid);
    } finally { f.dispose(); }
  }
});

test('correct hashes cannot hide malformed UTF-8, JSON, native shape or an excessive manifest', async () => {
  const f = await preparingIngressFixture();
  try {
    assert.equal(await storeFrozenRequest(f.db, f.lease, textRequest(), f.now), true);
    removeFixtureGuards(f);
    for (const bytes of [new Uint8Array([0xff]), new TextEncoder().encode('{'), new TextEncoder().encode('{}')]) {
      const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
      f.sql.prepare('UPDATE slack_ingress_chunks SET bytes=?,digest=?').run(bytes, hash);
      f.sql.prepare('UPDATE slack_ingress_manifests SET total_bytes=?,digest=?').run(bytes.length, hash);
      await assert.rejects(() => loadFrozenRequest(f.db, 'I1'));
    }
    f.sql.exec('PRAGMA ignore_check_constraints=ON');
    for (const change of ['total_bytes=11495905', 'chunk_count=13', 'encoding_version=2']) {
      f.sql.exec('UPDATE slack_ingress_manifests SET ' + change);
      await assert.rejects(() => loadFrozenRequest(f.db, 'I1'));
    }
  } finally { f.dispose(); }
});

test('whole-byte digest detects a changed ordinal-to-bytes association even with intact chunk hashes', async () => {
  const f = await preparingIngressFixture();
  try {
    assert.equal(await storeFrozenRequest(f.db, f.lease, largeImageRequest(), f.now), true);
    removeFixtureGuards(f);
    f.sql.exec('UPDATE slack_ingress_chunks SET ordinal=11 WHERE ordinal=0');
    f.sql.exec('UPDATE slack_ingress_chunks SET ordinal=0 WHERE ordinal=1');
    f.sql.exec('UPDATE slack_ingress_chunks SET ordinal=1 WHERE ordinal=11');
    await assert.rejects(() => loadFrozenRequest(f.db, 'I1'));
  } finally { f.dispose(); }
});

test('Unicode crossing a BLOB boundary and reverse physical insertion order replay exactly', async () => {
  const f = await preparingIngressFixture();
  try {
    const request = { ...textRequest(), message: '' };
    const prefix = new TextEncoder().encode(JSON.stringify({ id: request.id, message: '' }).slice(0, -2)).length;
    request.message = 'x'.repeat(999_999 - prefix) + '🙂世界' + 'end';
    assert.equal(await storeFrozenRequest(f.db, f.lease, request, f.now), true);
    const chunks = f.sql.prepare('SELECT * FROM slack_ingress_chunks ORDER BY ordinal DESC').all();
    assert.equal(chunks.length, 2);
    removeFixtureGuards(f);
    f.sql.exec('DELETE FROM slack_ingress_chunks');
    for (const chunk of chunks) f.sql.prepare('INSERT INTO slack_ingress_chunks VALUES(?,?,?,?)')
      .run(chunk.manifest_id, chunk.ordinal, chunk.bytes, chunk.digest);
    assert.deepEqual(await loadFrozenRequest(f.db, 'I1'), request);
  } finally { f.dispose(); }
});

test('request mutation during awaited writes cannot change already frozen original bytes', async () => {
  const f = await preparingIngressFixture();
  try {
    const request = structuredClone(textRequest());
    const original = structuredClone(request);
    const db = interceptDb(f.db, (query, _values, result) => {
      if (/INSERT INTO slack_ingress_manifests/.test(query)) request.message = 'changed while writing';
      return result;
    });
    assert.equal(await storeFrozenRequest(db, f.lease, request, f.now), true);
    assert.deepEqual(await loadFrozenRequest(f.db, 'I1'), original);
  } finally { f.dispose(); }
});

test('crash after a chunk commit leaves an invisible, retained attempt', async () => {
  const f = await preparingIngressFixture();
  try {
    const db = interceptDb(f.db, (query, _values, result) => {
      if (/INSERT INTO slack_ingress_chunks/.test(query)) throw new Error('fixture crash after chunk');
      return result;
    });
    await assert.rejects(() => storeFrozenRequest(db, f.lease, paddedRequest(), f.now), /fixture crash/);
    assert.equal(f.chunkCount(), 1); assert.equal(f.count('slack_ingress_manifests'), 1);
    assert.equal(f.sql.prepare('SELECT manifest_id FROM slack_ingress').get()!.manifest_id, null);
    await assert.rejects(() => loadFrozenRequest(f.db, 'I1'));
  } finally { f.dispose(); }
});

test('publication SQL rejects an attempt whose committed chunk vanished before publication', async () => {
  const f = await preparingIngressFixture();
  try {
    const db = interceptDb(f.db, (query, _values, result) => {
      if (/INSERT INTO slack_ingress_chunks/.test(query)) f.sql.exec('DELETE FROM slack_ingress_chunks');
      return result;
    });
    await assert.rejects(() => storeFrozenRequest(db, f.lease, textRequest(), f.now), /publication_guard/);
    assert.equal(f.sql.prepare('SELECT state FROM slack_ingress').get()!.state, 'preparing');
  } finally { f.dispose(); }
});

test('unknown publication with a different winner returns false and never replaces its bytes', async () => {
  const f = await preparingIngressFixture();
  try {
    const winner = { ...textRequest(), message: 'winner' };
    let won = false;
    const db = interceptDb(f.db, async (query, _values, result) => {
      if (/INSERT INTO slack_ingress_chunks/.test(query) && !won) {
        won = true; assert.equal(await storeFrozenRequest(f.db, f.lease, winner, f.now), true);
      }
      if (/UPDATE slack_ingress SET manifest_id/.test(query)) throw new Error('unknown losing publication');
      return result;
    });
    assert.equal(await storeFrozenRequest(db, f.lease, textRequest(), f.now), false);
    assert.deepEqual(await loadFrozenRequest(f.db, 'I1'), winner);
    assert.equal(f.count('slack_ingress_manifests'), 2);
  } finally { f.dispose(); }
});

test('actual migration prevents published payload updates, appends and deletions', async () => {
  const f = await preparingIngressFixture();
  try {
    assert.equal(await storeFrozenRequest(f.db, f.lease, textRequest(), f.now), true);
    for (const query of [
      "UPDATE slack_ingress_manifests SET digest='changed'",
      "UPDATE slack_ingress_chunks SET digest='changed'",
      'DELETE FROM slack_ingress_chunks', 'DELETE FROM slack_ingress_manifests',
      'INSERT INTO slack_ingress_chunks SELECT manifest_id,1,bytes,digest FROM slack_ingress_chunks',
    ]) assert.throws(() => f.sql.exec(query), /ingress_(manifest|chunk|retention)_guard/);
    assert.deepEqual(await loadFrozenRequest(f.db, 'I1'), textRequest());
  } finally { f.dispose(); }
});

test('readback enforces native envelope overhead even when manifest storage bounds and hashes pass', async () => {
  const f = await preparingIngressFixture();
  try {
    assert.equal(await storeFrozenRequest(f.db, f.lease, paddedRequest(), f.now), true);
    removeFixtureGuards(f);
    const bytes = new TextEncoder().encode(JSON.stringify(paddedRequest(11_500_000 - 4096 + 1)));
    assert.ok(bytes.length <= 11_500_000 - 4096);
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
    const last = bytes.subarray(11_000_000);
    const lastDigest = Buffer.from(await crypto.subtle.digest('SHA-256', last)).toString('hex');
    // Padding changed only within the final chunk, just before the trailing native fields.
    f.sql.prepare('UPDATE slack_ingress_chunks SET bytes=?,digest=? WHERE ordinal=11').run(last, lastDigest);
    f.sql.prepare('UPDATE slack_ingress_manifests SET total_bytes=?,digest=?').run(bytes.length, digest);
    await assert.rejects(() => loadFrozenRequest(f.db, 'I1'), /native envelope bound/);
  } finally { f.dispose(); }
});

test('valid smaller chunks obey the size cap and replay without a fixed-size layout assumption', async () => {
  const f = await preparingIngressFixture();
  try {
    const request = textRequest();
    const bytes = new TextEncoder().encode(JSON.stringify(request));
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
    const split = Math.floor(bytes.length / 3);
    f.sql.prepare('INSERT INTO slack_ingress_manifests VALUES(?,?,?,?,?,?,?,?,?)')
      .run('small', 'I1', 1, bytes.length, 2, digest, f.now, f.lease.owner, f.lease.revision);
    for (const [ordinal, chunk] of [bytes.subarray(0, split), bytes.subarray(split)].entries()) {
      const hash = Buffer.from(await crypto.subtle.digest('SHA-256', chunk)).toString('hex');
      f.sql.prepare('INSERT INTO slack_ingress_chunks VALUES(?,?,?,?)').run('small', ordinal, chunk, hash);
    }
    f.sql.prepare("UPDATE slack_ingress SET manifest_id='small',state='ready',revision=revision+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id='I1'")
      .run(f.now);
    assert.deepEqual(await loadFrozenRequest(f.db, 'I1'), request);
  } finally { f.dispose(); }
});

test('database availability exceptions preserve identity during guarded storage and chunk replay', async () => {
  const f = await preparingIngressFixture();
  try {
    const unavailable = new Error('fixture database unavailable');
    const guardDb = interceptDb(f.db, (query, _values, result) => {
      if (query.startsWith('SELECT id FROM slack_ingress')) throw unavailable;
      return result;
    });
    await assert.rejects(() => storeFrozenRequest(guardDb, f.lease, textRequest(), f.now), error => error === unavailable);
    assert.equal(f.count('slack_ingress_manifests'), 0);
    assert.equal(await storeFrozenRequest(f.db, f.lease, textRequest(), f.now), true);
    for (const select of ['SELECT m.*', 'SELECT ordinal,bytes,digest']) {
      const db = interceptDb(f.db, (query, _values, result) => {
        if (query.startsWith(select)) throw unavailable;
        return result;
      });
      await assert.rejects(() => loadFrozenRequest(db, 'I1'), error => error === unavailable && !(error instanceof FrozenRequestInvalid));
    }
  } finally { f.dispose(); }
});

test('invalid UTF-8 and JSON are typed validation failures with no parser content in the diagnostic', async () => {
  const f = await preparingIngressFixture();
  try {
    assert.equal(await storeFrozenRequest(f.db, f.lease, textRequest(), f.now), true);
    removeFixtureGuards(f);
    for (const bytes of [new Uint8Array([0xff]), new TextEncoder().encode('private-content-fixture{')]) {
      const digest = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
      f.sql.prepare('UPDATE slack_ingress_chunks SET bytes=?,digest=?').run(bytes, digest);
      f.sql.prepare('UPDATE slack_ingress_manifests SET total_bytes=?,digest=?').run(bytes.length, digest);
      await assert.rejects(() => loadFrozenRequest(f.db, 'I1'), error => {
        assert.ok(error instanceof FrozenRequestInvalid);
        assert.equal(error.message.includes('private-content-fixture'), false);
        return true;
      });
    }
  } finally { f.dispose(); }
});

await run();
