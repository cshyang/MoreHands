// node scripts/burst3-report.mjs ft-f.json ft-j.json ft-base.json  (any subset) -> per-burst tables, aggregates, custom-line counts
import fs from 'node:fs';
const norm = (t) => t.toLowerCase().replace(/[₀-₉]/g, (c) => String(c.charCodeAt(0) - 0x2080));
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : null);
const p90 = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(a.length * 0.9) - 1)] : null);
const LEAK = /\b(let me|i'll (check|look|find)|i will (check|look)|checking|looking (that )?up|one moment|hold on|just a (sec|moment))\b/i;
const isRL = (x) => x.outcome === 'failed' && /429|1302/.test(JSON.stringify(x.error ?? ''));
const aggs = [];
for (const file of process.argv.slice(2)) {
  const { arm, runs, dump } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const T = { arm, bursts: 0, sent: 0, answered: 0, lost: 0, rlTurns: 0, otherFailed: 0, reruns: 0, posts: 0, multiN: 0, multiWithin2: 0, allWithin2: 0, acks: 0, dangling: 0, dupAns: 0, capHits: 0, runaways: 0, emptyFinal: 0, leaks: 0, turns: 0, drains: 0, sweeps: 0, parked: 0, toolSent: 0, toolAnswered: 0, toolLeaks: 0, dupCaught: 0, dupSent: 0, latSingle: [], latMulti: [], pendingLeft: 0 };
  console.log(`\n=== arm ${arm}`);
  console.log('burst\ttool\tn\tans\tlost\trows\tacks\tdangl\tdupAns\tcap\tempty\tleak\tdrain\tsweep\tturns\tlat(s)\tattempts\tfailed(rl/other)');
  for (const { plan, attempts } of runs) {
    const fin = attempts[attempts.length - 1];
    const sends = fin.sends.filter((s) => !s.dup);
    const rows = dump.rows.filter((r) => r.conv === fin.conv);
    const posts = rows.filter((r) => r.kind === 'post');
    const rlFinal = fin.settled.filter(isRL).length;
    const otherFinal = fin.settled.filter((x) => x.outcome === 'failed' && !isRL(x)).length;
    let answered = 0, dupAns = 0;
    for (const m of sends) { const rs = posts.filter((r) => norm(r.text).includes(m.token)); if (rs.length) answered++; if (rs.length > 1) dupAns++; }
    const unanswered = sends.length - answered;
    const lost = rlFinal ? 0 : unanswered;
    const acks = rows.filter((r) => r.kind === 'ack');
    const dangling = acks.filter((r) => r.extra !== 'edited').length;
    const cap = rows.filter((r) => r.kind === 'cap_hit').length;
    const replyCalls = rows.filter((r) => r.kind === 'reply_call').length;
    const runaway = replyCalls > sends.length + 1 ? 1 : 0;
    const empty = rows.filter((r) => r.kind === 'empty_final').length;
    const leak = posts.filter((r) => LEAK.test(r.text)).length;
    const drain = rows.filter((r) => r.kind === 'drain').length, sweep = rows.filter((r) => r.kind === 'sweep').length;
    const parked = (dump.msgs.filter((m) => m.conv === fin.conv && m.path === 'parked')).length;
    const turns = dump.events.filter((e) => e.type === 'turn_request' && e.instance_id === fin.conv).length;
    const first = posts.map((r) => r.ts).sort((a, b) => a - b)[0];
    const lat = first && sends[0] ? (first - sends[0].sentAt) / 1000 : null;
    const pfTurns = attempts.reduce((n, a) => n + a.settled.filter(isRL).length, 0);
    console.log([plan.burst, plan.tool ? 'T' : '', sends.length, answered, lost, posts.length, acks.length, dangling, dupAns, cap, empty, leak, drain, sweep, turns, lat == null ? '-' : lat.toFixed(1), attempts.length, `${rlFinal}/${otherFinal}`].join('\t'));
    T.bursts++; T.sent += sends.length; T.answered += answered; T.lost += lost; T.rlTurns += pfTurns; T.otherFailed += otherFinal; T.reruns += attempts.length - 1;
    T.posts += posts.length; T.acks += acks.length; T.dangling += dangling; T.dupAns += dupAns; T.capHits += cap; T.runaways += runaway; T.emptyFinal += empty; T.leaks += leak; T.turns += turns; T.drains += drain; T.sweeps += sweep; T.parked += parked;
    if (posts.length <= 2) T.allWithin2++;
    if (!plan.single) { T.multiN++; if (posts.length <= 2) T.multiWithin2++; }
    if (plan.tool) { T.toolSent += sends.length; T.toolAnswered += answered; T.toolLeaks += leak; }
    for (const s of fin.sends.filter((s) => s.dup)) { T.dupSent++; if (s.caught) T.dupCaught++; }
    if (lat != null) (plan.single ? T.latSingle : T.latMulti).push(lat);
  }
  T.pendingLeft = (dump.pending ?? []).filter((p) => p.status === 'pending').length;
  aggs.push(T);
}
console.log('\n=== aggregate');
console.log('arm\tbursts\tsent\tanswered\tlost\trlTurns\totherFailedSubs\treruns\tposts\tmulti<=2\tall<=2\tacks\tdangling\tdupAns\tcapHits\trunaways\temptyFinal\tleaks\tturns/burst\tsingleLat med/p90\tmultiLat med/p90\ttoolAnswered\ttoolLeaks\tdrains\tsweeps\tparkedMsgs\tdupCaught');
for (const T of aggs) console.log([T.arm, T.bursts, T.sent, T.answered, T.lost, T.rlTurns, T.otherFailed, T.reruns, T.posts, `${T.multiWithin2}/${T.multiN}`, `${T.allWithin2}/${T.bursts}`, T.acks, T.dangling, T.dupAns, T.capHits, T.runaways, T.emptyFinal, T.leaks, (T.turns / T.bursts).toFixed(1), `${med(T.latSingle)?.toFixed(1)}/${p90(T.latSingle)?.toFixed(1)}`, `${med(T.latMulti)?.toFixed(1)}/${p90(T.latMulti)?.toFixed(1)}`, `${T.toolAnswered}/${T.toolSent}`, T.toolLeaks, T.drains, T.sweeps, T.parked, `${T.dupCaught}/${T.dupSent}`].join('\t'));

// ---- custom code lines (non-blank, non-comment) per arm, from the ARM markers, plus shared join-gateway code
const count = (lines) => lines.filter((l) => l.trim() && !l.trim().startsWith('//')).length;
const files = ['src/agents/gw2.ts', 'src/app.ts'].map((f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').split('\n'));
const arms = {};
for (const lines of files) { let cur = null; for (const l of lines) { const m = l.match(/ARM:(\w+):(start|end)/); if (m) { cur = m[2] === 'start' ? m[1] : null; arms[m[1]] ??= []; continue; } if (cur) arms[cur].push(l); } }
const block = (lines, startRe) => { const i = lines.findIndex((l) => startRe.test(l)); if (i < 0) return []; let d = 0, out = []; for (let k = i; k < lines.length; k++) { out.push(lines[k]); d += (lines[k].match(/\{/g) || []).length - (lines[k].match(/\}/g) || []).length; if (k > i && d <= 0) break; } return out; };
const stripArm = (lines) => { let skip = false; return lines.filter((l) => { const m = l.match(/ARM:(\w+):(start|end)/); if (m) { skip = m[2] === 'start'; return false; } return !skip; }); };
const sf = files.map(stripArm);
const shared = count(block(sf[0], /^function useCommon/)) + count(block(sf[0], /^function useLookup/)) + count(block(sf[1], /^async function gw2Dispatch/)) + count(block(sf[1], /^app\.post\('\/gw2', /)) + count(block(sf[1], /^async function gw2Schema/));
console.log('\n=== custom code lines (this sim, honest count; shared = join gateway, claim, ack/eyes, receipts, deliver, lookup tool)');
console.log(JSON.stringify({ base: count(arms.BASE ?? []), j: count(arms.J ?? []), f: count(arms.F ?? []), shared }));
