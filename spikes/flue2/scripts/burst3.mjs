// Final-text-as-reply comparison. node scripts/burst3.mjs <base|j|f> [seed] > out.json
// 26 bursts as in burst2 (same seed, same messages and gaps) + 6 tool-call bursts. Sequential, pause between bursts,
// provider-429 bursts re-run (max 2). Base arm also ticks the sweep every 10 s (20 s grace).
import fs from 'node:fs';
const BASE = 'http://localhost:5199';
// Optional checkpoint file survives an interrupted harness; resume never clears local D1.
const checkpoint = process.argv[4];
const resume = checkpoint && fs.existsSync(checkpoint) ? JSON.parse(fs.readFileSync(checkpoint, 'utf8')) : null;
const arm = process.argv[2] ?? 'j';
const ARM = arm.toUpperCase();
let seed = Number(process.argv[3] ?? 42);
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const Q = [
  ['What is the capital of Japan?', 'tokyo'], ['What color do you get mixing blue and red?', 'purple'],
  ['What is the first month of the year?', 'january'], ['What is the chemical symbol for water?', 'h2o'],
  ['What is the largest planet in our solar system?', 'jupiter'], ['What is the opposite of hot?', 'cold'],
  ['What is the capital of France?', 'paris'], ['What is the capital of Egypt?', 'cairo'],
  ['Which fruit is said to keep the doctor away?', 'apple'], ['What is the name of Earth\'s natural satellite?', 'moon'],
  ['What sweet food do bees make?', 'honey'], ['What color is a ripe banana?', 'yellow'],
];
const CUST = [['1042', 'orchid'], ['2203', 'falcon'], ['3310', 'juniper'], ['4125', 'saffron'], ['5507', 'walnut'], ['6618', 'cobalt']];
const T = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (path, init) => (await fetch(`${BASE}${path}`, init)).json();
const post = (b) => j('/gw2', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
await fetch(`${BASE}/events`);
if (!resume) await fetch(`${BASE}/gw2-reset`, { method: 'POST' });
await j('/gw2-config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ arm }) });

const plans = [];
for (let i = 0; i < 26; i++) {
  const single = i >= 20;
  const n = single ? 1 : 2 + Math.floor(rnd() * 3);
  const pool = [...Q].sort(() => rnd() - 0.5).slice(0, n);
  plans.push({ burst: `B${i + 1}`, single, tool: false, dupOf: [2, 8, 14, 17].includes(i) ? Math.floor(rnd() * n) : -1,
    msgs: pool.map(([text, token], k) => ({ text, token, sender: `u${1 + Math.floor(rnd() * 3)}`, gap: k === 0 ? 0 : 300 + Math.floor(rnd() * 3700) })) });
}
for (let i = 26; i < 32; i++) { // tool bursts: two messages, each needs lookup_customer
  const pool = [...CUST].sort(() => rnd() - 0.5).slice(0, 2);
  plans.push({ burst: `B${i + 1}`, single: false, tool: true, dupOf: -1,
    msgs: pool.map(([id, token], k) => ({ text: `What plan is customer ${id} on?`, token, sender: `u${1 + Math.floor(rnd() * 3)}`, gap: k === 0 ? 0 : 300 + Math.floor(rnd() * 3700) })) });
}
async function runOnce(p, attempt) {
  const conv = `project:aud:agent:default/conv:${ARM}-${p.burst}-a${attempt}-${T}@g1`;
  const sends = [];
  for (const [k, m] of p.msgs.entries()) {
    await sleep(m.gap);
    const event_id = `Ev-${ARM}-${T}-${p.burst}-a${attempt}-${k}`;
    const sentAt = Date.now();
    const r = await post({ event_id, text: m.text, token: m.token, sender: m.sender, conv, burst: `${p.burst}-a${attempt}` });
    sends.push({ event_id, token: m.token, sender: m.sender, sentAt, path: r.path });
    if (p.dupOf === k) { await sleep(150); const d = await post({ event_id, text: m.text, token: m.token, sender: m.sender, conv, burst: `${p.burst}-a${attempt}` }); sends.push({ dup: true, caught: !!d.dup }); }
  }
  let quiet = 0;
  for (let i = 0; i < 300 && quiet < 6; i++) { await sleep(1000); const s = await j('/gw2-state'); quiet = s.inflight === 0 && s.pending === 0 ? quiet + 1 : 0; }
  const settled = await j(`/gw-fail?conv=${encodeURIComponent(conv)}`);
  const rateLimited = settled.some((x) => x.outcome === 'failed' && /429|1302/.test(JSON.stringify(x.error ?? '')));
  return { conv, sends, settled, rateLimited };
}
let sweeping = true;
if (arm === 'base') (async () => { while (sweeping) { await sleep(10000); try { await j('/gw2-sweep', { method: 'POST' }); } catch {} } })();
const runs = resume?.runs ?? [];
for (const p of plans) {
  if (runs.some((r) => r.plan.burst === p.burst)) continue;
  const attempts = [];
  for (let a = 0; a < 3; a++) {
    const r = await runOnce(p, a);
    attempts.push(r);
    if (!r.rateLimited) break;
    await sleep(30000);
  }
  runs.push({ plan: p, attempts });
  if (checkpoint) fs.writeFileSync(checkpoint, JSON.stringify({ arm, runs, dump: await j('/gw-dump') }));
  console.error(`${ARM} ${p.burst} complete (${attempts.length} attempt(s))`);
  await sleep(8000);
}
sweeping = false;
const dump = await j('/gw-dump');
console.log(JSON.stringify({ arm, runs, dump }));
