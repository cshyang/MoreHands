// Usage: node scripts/go.mjs '<json body for dispatch>'
const base = process.env.BASE ?? 'http://localhost:5199';
const res = await fetch(`${base}/go`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: process.argv[2] });
console.log(res.status, await res.text());
