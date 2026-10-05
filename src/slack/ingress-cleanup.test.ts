import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { cleanupUnreferencedIngressAttempts } from './ingress-cleanup';
import { withIngressBudget, ingressBudget } from './ingress-budget';
import { storeFrozenRequest, loadFrozenRequest } from './frozen-request';
import { fixedIngressClock, interceptDb, paddedRequest, preparingIngressFixture, removeFixtureGuards, textRequest } from './test-utils/frozen-request';
const { test, run } = createTestRunner();
const GRACE = 24 * 60 * 60 * 1000;
type Fixture = Awaited<ReturnType<typeof preparingIngressFixture>>;

async function attempt(f: Fixture, id = 'M1', createdAt = f.now, partial = false, splitAt?: number) {
  const bytes = new TextEncoder().encode(JSON.stringify(textRequest()));
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const chunks = splitAt === undefined ? [bytes] : [bytes.subarray(0, splitAt), bytes.subarray(splitAt)];
  f.sql.prepare('INSERT INTO slack_ingress_manifests VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, f.lease.id, 1, bytes.length, chunks.length, digest, createdAt, f.lease.owner, f.lease.revision);
  if (!partial) for (const [ordinal, chunk] of chunks.entries()) {
    const chunkDigest = Buffer.from(await crypto.subtle.digest('SHA-256', chunk)).toString('hex');
    f.sql.prepare('INSERT INTO slack_ingress_chunks VALUES(?,?,?,?)').run(id, ordinal, chunk, chunkDigest);
  }
}

function abandon(f: Fixture) {
  f.sql.exec("UPDATE slack_ingress SET lease_owner=NULL,lease_expires_at=NULL,revision=revision+1 WHERE id='I1'");
}

test('abandoned attempt deletes chunks before its manifest at the 24h grace boundary', async () => {
  const f = await preparingIngressFixture();
  const restoreClock = fixedIngressClock();
  try {
    await attempt(f); abandon(f);
    assert.deepEqual(await cleanupUnreferencedIngressAttempts(f.db, { now: f.now + GRACE - 1, limit: 8 }), { deleted: 0, retained: 0 });
    assert.deepEqual(await cleanupUnreferencedIngressAttempts(f.db, { now: f.now + GRACE, limit: 8 }), { deleted: 1, retained: 0 });
    assert.equal(f.chunkCount(), 0); assert.equal(f.count('slack_ingress_manifests'), 0);
    assert.equal(f.count('slack_ingress'), 1); assert.equal(f.count('cutover_producers'), 1);
    assert.deepEqual(await cleanupUnreferencedIngressAttempts(f.db, { now: f.now + GRACE, limit: 8 }), { deleted: 0, retained: 0 });
  } finally { restoreClock(); f.dispose(); }
});

test('unfinished chunk writes are reclaimed only after grace and no live recorded lease', async () => {
  const f = await preparingIngressFixture();
  const restoreClock = fixedIngressClock();
  try {
    await attempt(f, 'partial', f.now, true);
    const now = f.now + GRACE;
    f.sql.prepare('UPDATE slack_ingress SET lease_expires_at=?').run(now + 1);
    assert.deepEqual(await cleanupUnreferencedIngressAttempts(f.db, { now, limit: 8 }), { deleted: 0, retained: 1 });
    assert.equal(f.count('slack_ingress_manifests'), 1);
    assert.deepEqual(await cleanupUnreferencedIngressAttempts(f.db, { now: now + 2, limit: 8 }), { deleted: 1, retained: 0 });
  } finally { restoreClock(); f.dispose(); }
});

test('failed ingress preserves unpublished diagnostic bytes', async () => {
  const f = await preparingIngressFixture();
  try {
    await attempt(f); abandon(f);
    f.sql.exec("UPDATE slack_ingress SET state='failed'");
    assert.deepEqual(await cleanupUnreferencedIngressAttempts(f.db, { now: f.now + GRACE, limit: 8 }), { deleted: 0, retained: 1 });
    assert.equal(f.chunkCount(), 1); assert.equal(f.count('slack_ingress_manifests'), 1);
  } finally { f.dispose(); }
});

test('every referenced state preserves published payloads and audit identity', async () => {
  for (const state of ['received', 'preparing', 'ready', 'uncertain', 'accepted', 'failed']) {
    const f = await preparingIngressFixture();
    try {
      assert.equal(await storeFrozenRequest(f.db, f.lease, textRequest(), f.now), true);
      removeFixtureGuards(f);
      f.sql.prepare('UPDATE slack_ingress SET state=?').run(state);
      const before = f.sql.prepare('SELECT * FROM slack_ingress').get();
      assert.deepEqual(await cleanupUnreferencedIngressAttempts(f.db, { now: f.now + GRACE + 1000, limit: 8 }), { deleted: 0, retained: 1 });
      assert.equal(f.chunkCount(), 1); assert.equal(f.count('slack_ingress_manifests'), 1);
      assert.deepEqual(f.sql.prepare('SELECT * FROM slack_ingress').get(), before);
    } finally { f.dispose(); }
  }
});

test('published-first race retains bytes; cleanup-first race prevents readiness', async () => {
  const f = await preparingIngressFixture();
  try {
    await attempt(f);
    const now = f.now + GRACE;
    let entered = false;
    const db = { ...f.db, batch: async (statements: Parameters<typeof f.db.batch>[0]) => {
      entered = true;
      f.sql.prepare('UPDATE slack_ingress SET lease_expires_at=?').run(now + 60_000);
      f.sql.prepare("UPDATE slack_ingress SET manifest_id='M1',state='ready',revision=revision+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id='I1'").run(now);
      return f.db.batch(statements);
    } };
    assert.deepEqual(await cleanupUnreferencedIngressAttempts(db, { now, limit: 8 }), { deleted: 0, retained: 1 });
    assert.equal(entered, true);
    assert.deepEqual(await loadFrozenRequest(f.db, 'I1'), textRequest());
  } finally { f.dispose(); }
  const g = await preparingIngressFixture();
  try {
    await attempt(g);
    const now = g.now + GRACE;
    assert.deepEqual(await cleanupUnreferencedIngressAttempts(g.db, { now, limit: 8 }), { deleted: 1, retained: 0 });
    g.sql.prepare('UPDATE slack_ingress SET lease_expires_at=?').run(now + 60_000);
    assert.throws(() => g.sql.prepare("UPDATE slack_ingress SET manifest_id='M1',state='ready',revision=revision+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id='I1'").run(now), /publication_guard/);
    assert.equal(g.sql.prepare('SELECT state FROM slack_ingress').get()!.state, 'preparing');
  } finally { g.dispose(); }
});

test('renewal after candidate read is rechecked inside the deletion batch', async () => {
  const f = await preparingIngressFixture();
  try {
    await attempt(f);
    const now = f.now + GRACE;
    let entered = false;
    const db = { ...f.db, batch: async (statements: Parameters<typeof f.db.batch>[0]) => {
      entered = true;
      f.sql.prepare('UPDATE slack_ingress SET lease_expires_at=?').run(now + 60_000);
      return f.db.batch(statements);
    } };
    assert.deepEqual(await cleanupUnreferencedIngressAttempts(db, { now, limit: 8 }), { deleted: 0, retained: 1 });
    assert.equal(entered, true); assert.equal(f.chunkCount(), 1);
  } finally { f.dispose(); }
});

test('ownership mismatch, missing ingress and corrupt metadata retain attempts', async () => {
  for (const corruption of [
    "UPDATE slack_ingress SET lease_owner='different'",
    "UPDATE slack_ingress_manifests SET preparation_revision=99",
    "UPDATE slack_ingress_manifests SET digest='bad'",
    "UPDATE slack_ingress_manifests SET created_at='bad'",
    "UPDATE slack_ingress SET lease_expires_at=-1",
    "UPDATE slack_ingress_chunks SET ordinal=5",
    "UPDATE slack_ingress_chunks SET digest='bad'",
    "UPDATE slack_ingress_chunks SET bytes=X'01'",
    "DELETE FROM slack_ingress",
  ]) {
    const f = await preparingIngressFixture();
    try {
      await attempt(f); removeFixtureGuards(f); f.sql.exec('PRAGMA foreign_keys=OFF');
      f.sql.exec(corruption);
      assert.deepEqual(await cleanupUnreferencedIngressAttempts(f.db, { now: f.now + GRACE, limit: 8 }), { deleted: 0, retained: 1 });
      assert.equal(f.chunkCount(), 1); assert.equal(f.count('slack_ingress_manifests'), 1);
    } finally { f.dispose(); }
  }
});

test('manifest-delete failure rolls chunk deletion back in the same actual SQL transaction', async () => {
  const f = await preparingIngressFixture();
  try {
    await attempt(f); abandon(f);
    f.sql.exec("CREATE TRIGGER fixture_abort_delete BEFORE DELETE ON slack_ingress_manifests BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
    await assert.rejects(() => cleanupUnreferencedIngressAttempts(f.db, { now: f.now + GRACE, limit: 8 }));
    assert.equal(f.chunkCount(), 1); assert.equal(f.count('slack_ingress_manifests'), 1);
  } finally { f.dispose(); }
});

test('lost cleanup commit response is verified from metadata, without repeating chunk deletion', async () => {
  const f = await preparingIngressFixture();
  try {
    await attempt(f); abandon(f); f.loseNextCommitResponse();
    assert.deepEqual(await cleanupUnreferencedIngressAttempts(f.db, { now: f.now + GRACE, limit: 8 }), { deleted: 1, retained: 0 });
    assert.equal(f.chunkCount(), 0); assert.equal(f.count('slack_ingress_manifests'), 0);
  } finally { f.dispose(); }
});

test('response loss after only chunks disappeared cannot be reported as a clean result', async () => {
  const f = await preparingIngressFixture();
  try {
    await attempt(f); abandon(f);
    const db = { ...f.db, batch: async (_statements: Parameters<typeof f.db.batch>[0]) => {
      f.sql.exec("DELETE FROM slack_ingress_chunks WHERE manifest_id='M1'");
      throw new Error('interrupted deletion');
    } };
    await assert.rejects(() => cleanupUnreferencedIngressAttempts(db, { now: f.now + GRACE, limit: 8 }));
    assert.equal(f.count('slack_ingress_manifests'), 1);
  } finally { f.dispose(); }
});

test('cleanup caps candidates at eight and submits at most sixteen statements in one batch', async () => {
  const f = await preparingIngressFixture();
  try {
    for (let i = 0; i < 11; i++) await attempt(f, 'M' + i);
    abandon(f);
    let batches = 0;
    const db = { ...f.db, batch: async (statements: Parameters<typeof f.db.batch>[0]) => {
      batches++; assert.ok(statements.length <= 16);
      return f.db.batch(statements);
    } };
    assert.deepEqual(await cleanupUnreferencedIngressAttempts(db, { now: f.now + GRACE, limit: 999 }), { deleted: 8, retained: 0 });
    assert.equal(batches, 1); assert.equal(f.count('slack_ingress_manifests'), 3);
    assert.deepEqual(await cleanupUnreferencedIngressAttempts(db, { now: f.now + GRACE, limit: 2 }), { deleted: 2, retained: 0 });
  } finally { f.dispose(); }
});

test('changed metadata after selection is retained; invalid operation bounds never delete', async () => {
  const f = await preparingIngressFixture();
  try {
    await attempt(f); abandon(f);
    let changed = false;
    const db = interceptDb(f.db, (query, _values, result) => {
      if (/SELECT/.test(query) && /FROM slack_ingress_manifests/.test(query) && !changed) {
        changed = true; removeFixtureGuards(f);
        f.sql.exec("UPDATE slack_ingress_manifests SET digest='b' || substr(digest,2)");
      }
      return result;
    });
    assert.deepEqual(await cleanupUnreferencedIngressAttempts(db, { now: f.now + GRACE, limit: 8 }), { deleted: 0, retained: 1 });
    assert.equal(f.chunkCount(), 1);
    for (const limit of [0, -1, 0.5, NaN, Infinity]) {
      await assert.rejects(() => cleanupUnreferencedIngressAttempts(f.db, { now: f.now + GRACE, limit }));
    }
    await assert.rejects(() => cleanupUnreferencedIngressAttempts(f.db, { now: NaN, limit: 8 }));
  } finally { f.dispose(); }
});

test('old retained payloads cannot crowd abandoned attempts out of the bounded scan', async () => {
  const f = await preparingIngressFixture();
  try {
    await attempt(f); abandon(f);
    for (let i = 0; i < 8; i++) {
      const ingressId = 'R' + i, manifestId = 'RM' + i;
      f.sql.prepare("INSERT INTO slack_ingress(id,team_id,event_id,digest,event_json,state,revision,created_at,updated_at) SELECT ?,team_id,?,digest,event_json,'received',1,created_at,updated_at FROM slack_ingress WHERE id='I1'")
        .run(ingressId, 'RE' + i);
      f.sql.prepare("INSERT INTO slack_ingress_manifests SELECT ?,?,encoding_version,total_bytes,chunk_count,digest,created_at-1,preparation_owner,preparation_revision FROM slack_ingress_manifests WHERE id='M1'")
        .run(manifestId, ingressId);
      f.sql.prepare("INSERT INTO slack_ingress_chunks SELECT ?,ordinal,bytes,digest FROM slack_ingress_chunks WHERE manifest_id='M1'")
        .run(manifestId);
      f.sql.prepare('UPDATE slack_ingress SET manifest_id=? WHERE id=?').run(manifestId, ingressId);
    }
    assert.deepEqual(await cleanupUnreferencedIngressAttempts(f.db, { now: f.now + GRACE + 1000, limit: 1 }), { deleted: 1, retained: 0 });
    assert.equal(f.count('slack_ingress_manifests'), 8); assert.equal(f.chunkCount(), 8);
  } finally { f.dispose(); }
});

test('cleanup validates smaller chunks by actual lengths and hashes before deleting the attempt', async () => {
  const f = await preparingIngressFixture();
  try {
    await attempt(f, 'small', f.now, false, 13); abandon(f);
    assert.deepEqual(await cleanupUnreferencedIngressAttempts(f.db, { now: f.now + GRACE, limit: 8 }), { deleted: 1, retained: 0 });
    assert.equal(f.chunkCount(), 0); assert.equal(f.count('slack_ingress_manifests'), 0);
  } finally { f.dispose(); }
});

test('database errors that resemble validation messages remain unavailable and never authorize cleanup', async () => {
  const f = await preparingIngressFixture();
  try {
    await attempt(f); abandon(f);
    const unavailable = new Error('Invalid attempt database unavailable');
    const db = interceptDb(f.db, (query, _values, result) => {
      if (query.startsWith('SELECT ordinal,length(bytes)')) throw unavailable;
      return result;
    });
    await assert.rejects(() => cleanupUnreferencedIngressAttempts(db, { now: f.now + GRACE, limit: 8 }), error => error === unavailable);
    assert.equal(f.count('slack_ingress_manifests'), 1); assert.equal(f.chunkCount(), 1);
  } finally { f.dispose(); }
});

test('eight complete twelve-chunk attempts stay within fifty statements and resume on later invocations', async () => {
  const f = await preparingIngressFixture();
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(paddedRequest()));
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
    const chunks: { bytes: Uint8Array; digest: string }[] = [];
    for (let offset = 0; offset < bytes.length; offset += 1_000_000) {
      const chunk = bytes.subarray(offset, Math.min(offset + 1_000_000, bytes.length));
      chunks.push({ bytes: chunk, digest: Buffer.from(await crypto.subtle.digest('SHA-256', chunk)).toString('hex') });
    }
    assert.equal(chunks.length, 12);
    for (let index = 0; index < 8; index++) {
      const id = 'large' + index;
      f.sql.prepare('INSERT INTO slack_ingress_manifests VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, f.lease.id, 1, bytes.length, chunks.length, digest, f.now, f.lease.owner, f.lease.revision);
      for (const [ordinal, chunk] of chunks.entries()) {
        f.sql.prepare('INSERT INTO slack_ingress_chunks VALUES(?,?,?,?)').run(id, ordinal, chunk.bytes, chunk.digest);
      }
    }
    abandon(f);
    let batches = 0;
    const sourceDb = { ...f.db, batch: async (statements: Parameters<typeof f.db.batch>[0]) => {
      batches++; return f.db.batch(statements);
    } };
    const expected = [{ deleted: 3, retained: 5 }, { deleted: 3, retained: 2 }, { deleted: 2, retained: 0 }];
    for (const [index, result] of expected.entries()) {
      const db = withIngressBudget({ DB: sourceDb }).DB;
      const observed = await cleanupUnreferencedIngressAttempts(db, { now: f.now + GRACE, limit: 8 });
      assert.ok(ingressBudget(db)!.used <= 50, 'cleanup exceeded fifty actual SQL statements');
      assert.equal(ingressBudget(db)!.used, index < 2 ? 49 : 33);
      assert.deepEqual(observed, result);
      const remaining = 8 - expected.slice(0, index + 1).reduce((sum, entry) => sum + entry.deleted, 0);
      assert.equal(f.count('slack_ingress_manifests'), remaining);
      assert.equal(f.chunkCount(), remaining * 12);
      assert.equal(batches, index + 1);
    }
    const db = withIngressBudget({ DB: sourceDb }).DB;
    assert.deepEqual(await cleanupUnreferencedIngressAttempts(db, { now: f.now + GRACE, limit: 8 }), { deleted: 0, retained: 0 });
    assert.equal(ingressBudget(db)!.used, 1);
  } finally { f.dispose(); }
});

test('large-attempt response loss preserves the fifty-statement bound and remaining payloads', async () => {
  const f = await preparingIngressFixture();
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(paddedRequest()));
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
    for (let index = 0; index < 4; index++) {
      const id = 'lost' + index;
      f.sql.prepare('INSERT INTO slack_ingress_manifests VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, f.lease.id, 1, bytes.length, 12, digest, f.now, f.lease.owner, f.lease.revision);
      for (let ordinal = 0; ordinal < 12; ordinal++) {
        const chunk = bytes.subarray(ordinal * 1_000_000, Math.min((ordinal + 1) * 1_000_000, bytes.length));
        const chunkDigest = Buffer.from(await crypto.subtle.digest('SHA-256', chunk)).toString('hex');
        f.sql.prepare('INSERT INTO slack_ingress_chunks VALUES(?,?,?,?)').run(id, ordinal, chunk, chunkDigest);
      }
    }
    abandon(f); f.loseNextCommitResponse();
    const db = withIngressBudget({ DB: f.db }).DB;
    const result = await cleanupUnreferencedIngressAttempts(db, { now: f.now + GRACE, limit: 8 });
    assert.ok(ingressBudget(db)!.used <= 50, 'ambiguous cleanup exceeded fifty SQL statements');
    assert.equal(ingressBudget(db)!.used, 49);
    assert.deepEqual(result, { deleted: 3, retained: 1 });
    assert.equal(f.count('slack_ingress_manifests'), 1); assert.equal(f.chunkCount(), 12);
    assert.deepEqual(await cleanupUnreferencedIngressAttempts(f.db, { now: f.now + GRACE, limit: 8 }), { deleted: 1, retained: 0 });
  } finally { f.dispose(); }
});

await run();
