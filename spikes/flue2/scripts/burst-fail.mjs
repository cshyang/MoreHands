// node scripts/burst-fail.mjs out.json : settle outcomes, error kinds, finish nudges
import fs from 'node:fs';
const { dump } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const c = {}, m = {};
for (const e of dump.events) { if (e.type !== 'submission_settled') continue; const b = JSON.parse(e.body); c[b.outcome + ':' + (b.error?.type || '')] = (c[b.outcome + ':' + (b.error?.type || '')] || 0) + 1; if (b.outcome !== 'completed') { const k = String(b.error?.message || '').replace(/dispatch\(sub_[a-z0-9_]+\)/, 'dispatch()').slice(0, 90); m[k] = (m[k] || 0) + 1; } }
console.log('settled', JSON.stringify(c)); console.log('errors', JSON.stringify(m));
console.log('finish_nudges', dump.rows.filter((r) => r.kind === 'finish_nudge').length);
