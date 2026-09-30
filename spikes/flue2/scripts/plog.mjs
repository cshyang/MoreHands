// node scripts/plog.mjs <instance> : merged timeline of plog rows + observer events (selected types)
const inst = process.argv[2];
const types = new Set(['submission_queued','submission_running','submission_settled','submission_recovery','tool_start','tool','turn_request','agent_end']);
const base = 'http://localhost:5199';
const p = await (await fetch(`${base}/plog?instance=${encodeURIComponent(inst)}`)).json();
const e = (await (await fetch(`${base}/events?instance=${encodeURIComponent(inst)}`)).json()).filter((r) => types.has(r.type));
const rows = [...p.map((r) => ({ ts: r.ts, k: 'plog', t: r.what, x: r.extra })), ...e.map((r) => { const b = JSON.parse(r.body); delete b.systemPrompt; delete b.tail; return { ts: r.ts, k: 'evt', t: r.type, x: JSON.stringify(b).slice(0, 220) }; })].sort((a, b) => a.ts - b.ts);
const t0 = rows[0]?.ts ?? 0;
for (const r of rows) console.log(`+${String(r.ts - t0).padStart(6)}ms ${r.k} ${r.t.padEnd(24)} ${r.x ?? ''}`);
