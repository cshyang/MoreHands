// Policy comparison harness. node scripts/burst2.mjs <A|B2000|B1000> [seed] > out.json
// Sequential: one burst at a time, pause between bursts, re-run a burst (max 2) whose submission failed on a provider 429/1302.
const BASE = 'http://localhost:5199';
const arm = process.argv[2] ?? 'A';
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
const T = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (path, init) => (await fetch(`${BASE}${path}`, init)).json();
const post = (b) => j('/gw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
await fetch(`${BASE}/events`); await fetch(`${BASE}/gw-reset`, { method: 'POST' });
await j('/gw-config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(arm === 'A' ? { policy: 'A', windowMs: 0 } : arm === 'C' ? { policy: 'C', windowMs: 2000, cooldownMs: 3000 } : { policy: 'B', windowMs: Number(arm.slice(1)) }) });

const plans = [];
for (let i = 0; i < 26; i++) {
  const single = i >= 20;
  const n = single ? 1 : 2 + Math.floor(rnd() * 3);
  const pool = [...Q].sort(() => rnd() - 0.5).slice(0, n);
  plans.push({ burst: `B${i + 1}`, single, dupOf: [2, 8, 14, 17].includes(i) ? Math.floor(rnd() * n) : -1,
    msgs: pool.map(([text, token], k) => ({ text, token, sender: `u${1 + Math.floor(rnd() * 3)}`, gap: k === 0 ? 0 : 300 + Math.floor(rnd() * 3700) })) });
}
async function runOnce(p, attempt) {
  const conv = `project:aud:agent:default/conv:${arm}-${p.burst}-a${attempt}-${T}@g1`;
  const sends = [];
  for (const [k, m] of p.msgs.entries()) {
    await sleep(m.gap);
    const event_id = `Ev-${arm}-${T}-${p.burst}-a${attempt}-${k}`;
    const sentAt = Date.now();
    const r = await post({ event_id, text: m.text, token: m.token, sender: m.sender, conv, burst: `${p.burst}-a${attempt}` });
    sends.push({ event_id, token: m.token, sender: m.sender, sentAt, path: r.path });
    if (p.dupOf === k) { await sleep(150); const d = await post({ event_id, text: m.text, token: m.token, sender: m.sender, conv, burst: `${p.burst}-a${attempt}` }); sends.push({ dup: true, caught: !!d.dup }); }
  }
  let quiet = 0;
  for (let i = 0; i < 300 && quiet < 6; i++) { await sleep(1000); const s = await j('/gw-state'); quiet = s.inflight === 0 && s.batches === 0 ? quiet + 1 : 0; }
  const settled = await j(`/gw-fail?conv=${encodeURIComponent(conv)}`);
  const rateLimited = settled.some((x) => x.outcome === 'failed' && /429|1302/.test(JSON.stringify(x.error ?? '')));
  return { conv, sends, settled, rateLimited };
}
const runs = [];
for (const p of plans) {
  const attempts = [];
  for (let a = 0; a < 3; a++) {
    const r = await runOnce(p, a);
    attempts.push(r);
    if (!r.rateLimited) break;
    await sleep(30000); // back off before re-running a rate-limited burst
  }
  runs.push({ plan: p, attempts });
  await sleep(8000);
}
const dump = await j('/gw-dump');
console.log(JSON.stringify({ arm, runs, dump }));
