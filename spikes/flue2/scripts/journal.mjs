// Inspect the local DO SQLite journals (miniflare state). Usage: node scripts/journal.mjs [pathSubstring]
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = '.wrangler/state/v3/do/flue2-spike-FlueProjectAgent';
const filter = process.argv[2];
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.sqlite') || f === 'metadata.sqlite') continue;
  const db = new DatabaseSync(join(dir, f), { readOnly: true });
  let streams;
  try {
    streams = db.prepare('SELECT path, next_offset FROM flue_conversation_streams').all();
  } catch {
    db.close();
    continue;
  }
  for (const s of streams) {
    if (filter && !s.path.includes(filter)) continue;
    const b = db.prepare('SELECT count(*) n, max(length(data)) maxLen, sum(length(data)) totLen FROM flue_conversation_stream_batches WHERE path=?').get(s.path);
    let c = { n: 0, maxLen: 0, totLen: 0 };
    try {
      c = db.prepare('SELECT count(*) n, max(length(data)) maxLen, sum(length(data)) totLen FROM flue_conversation_stream_batch_chunks WHERE path=?').get(s.path);
    } catch {}
    console.log(`${s.path}\n  file=${(statSync(join(dir, f)).size / 1024).toFixed(0)}KB batches=${b.n} maxBatchLen=${b.maxLen} totBatchLen=${b.totLen} | chunkRows=${c.n} maxChunkLen=${c.maxLen} totChunkLen=${c.totLen}`);
  }
  db.close();
}
