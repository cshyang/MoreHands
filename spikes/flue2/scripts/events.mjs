// Print captured observer events. Usage: node scripts/events.mjs [instanceSubstring] [--types=a,b] [--full]
const base = process.env.BASE ?? 'http://localhost:5199';
const args = process.argv.slice(2);
const inst = args.find((a) => !a.startsWith('--'));
const types = (args.find((a) => a.startsWith('--types=')) ?? '').slice(8).split(',').filter(Boolean);
const full = args.includes('--full');
const rows = await (await fetch(`${base}/events`)).json();
let t0;
for (const r of rows) {
  if (inst && !(r.instance_id ?? '').includes(inst)) continue;
  if (types.length && !types.includes(r.type)) continue;
  t0 ??= r.ts;
  const b = JSON.parse(r.body);
  if (!full && b.systemPrompt) b.systemPrompt = '…' + b.systemPrompt.slice(-260);
  console.log(`${String(r.seq).padStart(4)} +${String(r.ts - t0).padStart(6)}ms ${r.type.padEnd(20)} ${(r.submission_id ?? '').slice(0, 10).padEnd(10)} ${JSON.stringify(b).slice(0, full ? 4000 : 360)}`);
}
