// Print non-delta canonical records for an instance path substring: node scripts/records.mjs B1
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
const filter = process.argv[2];
for (const agent of readdirSync('.wrangler/state/v3/do')) {
  if (!agent.includes('FlueRetry')) continue;
  const dir = `.wrangler/state/v3/do/${agent}`;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.sqlite') || f === 'metadata.sqlite') continue;
    const db = new DatabaseSync(`${dir}/${f}`, { readOnly: true });
    try {
      for (const s of db.prepare('SELECT path FROM flue_conversation_streams').all()) {
        if (!s.path.includes(filter)) continue;
        console.log('##', s.path);
        for (const b of db.prepare('SELECT data FROM flue_conversation_stream_batches WHERE path=? ORDER BY seq').all(s.path)) {
          for (const r of JSON.parse(b.data)) {
            if (/delta|text_started|reasoning_started|completed$/.test(r.type) && !/tool/.test(r.type)) continue;
            const { v, id, conversationId, harness, session, operationId, turnId, messageId, blockId, ...rest } = r;
            console.log(JSON.stringify(rest).slice(0, 900));
          }
        }
      }
    } catch (e) {}
  }
}
