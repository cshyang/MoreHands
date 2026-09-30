// Show the shape of one journaled delta record (proves `partial` is not persisted).
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
const dir = '.wrangler/state/v3/do/flue2-spike-FlueProjectAgent';
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.sqlite') || f === 'metadata.sqlite') continue;
  const db = new DatabaseSync(`${dir}/${f}`, { readOnly: true });
  try {
    const row = db.prepare("SELECT data FROM flue_conversation_stream_batches WHERE path LIKE '%STREAM1%' ORDER BY length(data) DESC LIMIT 1").get();
    if (row) {
      const recs = JSON.parse(row.data);
      const d = recs.filter((r) => r.type === 'assistant_text_delta');
      console.log('records in largest batch:', recs.length, '| keys of a delta record:', Object.keys(d[0] ?? recs[0]).join(','));
      console.log('sample:', JSON.stringify(d[0] ?? recs[0]));
      console.log('batch JSON contains "partial":', row.data.includes('"partial"'));
    }
  } catch {}
}
