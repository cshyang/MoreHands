// 20 bursts against /gw. Deterministic (seeded). node scripts/burst.mjs [seed] > out.json
const BASE = 'http://localhost:5199';
let seed = Number(process.argv[2] ?? 42);
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const Q = [
  ['What is the capital of Japan?', 'tokyo'], ['What color do you get mixing blue and red?', 'purple'],
  ['What is the first month of the year?', 'january'], ['What is the chemical symbol for water?', 'h2o'],
  ['What is the largest planet in our solar system?', 'jupiter'], ['What is the opposite of hot?', 'cold'],
  ['What is the capital of France?', 'paris'], ['What is the capital of Egypt?', 'cairo'],
  ['Which fruit is said to keep the doctor away?', 'apple'], ['What is the name of Earth\'s natural satellite?', 'moon'],
  ['What sweet food do bees make?', 'honey'], ['What color is a ripe banana?', 'yellow'],
];
const T = Date.now();
const post = async (b) => (await fetch(`${BASE}/gw`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await fetch(`${BASE}/events`); await fetch(`${BASE}/gw-reset`, { method: 'POST' });

const plans = [];
for (let i = 0; i < 20; i++) {
  const n = 2 + Math.floor(rnd() * 3);
  const pool = [...Q].sort(() => rnd() - 0.5).slice(0, n);
  plans.push({ burst: `B${i + 1}`, conv: `project:aud:agent:default/conv:B${i + 1}-${T}@g1`,
    dupOf: [2, 8, 14, 17].includes(i) ? Math.floor(rnd() * n) : -1,
    msgs: pool.map(([text, token], k) => ({ event_id: `Ev-${T}-${i + 1}-${k}`, text, token, sender: `u${1 + Math.floor(rnd() * 3)}`, gap: k === 0 ? 0 : 300 + Math.floor(rnd() * 3700) })) });
}
async function run(p) {
  const out = [];
  for (const [k, m] of p.msgs.entries()) {
    await sleep(m.gap);
    const r = await post({ ...m, conv: p.conv, burst: p.burst, ...(process.env.MODEL ? { model: process.env.MODEL } : {}) });
    out.push(r);
    if (p.dupOf === k) { await sleep(150); const d = await post({ ...m, conv: p.conv, burst: p.burst, ...(process.env.MODEL ? { model: process.env.MODEL } : {}) }); if (!d.dup) out.push({ dupNotCaught: true }); }
  }
  return out;
}
const queue = [...plans];
await Promise.all(Array.from({ length: Number(process.argv[3] ?? 4) }, async () => { while (queue.length) await run(queue.shift()); }));
// wait for quiescence: nothing in flight for 25 s
let quiet = 0;
for (let i = 0; i < 400 && quiet < 25; i++) { await sleep(1000); const s = await (await fetch(`${BASE}/gw-state`)).json(); quiet = s.inflight === 0 ? quiet + 1 : 0; }
const dump = await (await fetch(`${BASE}/gw-dump`)).json();
console.log(JSON.stringify({ plans, dump }));
