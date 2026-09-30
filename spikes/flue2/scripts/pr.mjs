// node scripts/pr.mjs <agent> <id> "<text>" [key|-] [model]  -> POST /probe, prints receipt
const [agent, id, text, key, model, seq] = process.argv.slice(2);
const body = { agent, id, message: { kind: 'signal', type: 'slack.message', body: text, attributes: { sender: 'u1', ...(model && model !== '-' ? { model } : {}), ...(seq ? { seq } : {}) } }, ...(key && key !== '-' ? { idempotencyKey: key } : {}) };
const t0 = Date.now();
const res = await fetch('http://localhost:5199/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
console.log(`+${Date.now() - t0}ms`, res.status, (await res.text()).slice(0, 300));
