// node scripts/burst2-report.mjs out1.json [out2.json ...]  -> per-burst table per arm, then an aggregate comparison
import fs from 'node:fs';
const norm = (t) => t.toLowerCase().replace(/[₀-₉]/g, (c) => String(c.charCodeAt(0) - 0x2080));
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : null);
const p90 = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(a.length * 0.9) - 1)] : null);
const aggs = [];
const subs = [];
for (const file of process.argv.slice(2)) {
  const { arm, runs, dump } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const S = { arm, bursts: 0, ceilBursts: 0, sent: 0, answered: 0, rows: 0, within2: 0, turns: 0, dupAns: 0, lat: [] };
  const T = { arm, bursts: 0, sent: 0, answered: 0, lost: 0, providerFailedMsgs: 0, providerFailedTurns: 0, reruns: 0, replyRows: 0, multiWithin2: 0, multiN: 0, allWithin2: 0, acks: 0, eyes: 0, dupAns: 0, capHits: 0, nudges: 0, turns: 0, cwin: 0, dupCaught: 0, dupSent: 0, senderOk: 0, senderN: 0, latSingle: [], latMulti: [] };
  console.log(`\n=== arm ${arm}`);
  console.log('burst\tn\tans\tlost\tpfail\trows\tacks\teyes\tdupAns\tcap\tnudge\tturns\tlat1stReply(s)\tattempts\tcwin');
  for (const { plan, attempts } of runs) {
    const fin = attempts[attempts.length - 1];
    const sends = fin.sends.filter((s) => !s.dup);
    const rows = dump.rows.filter((r) => r.conv === fin.conv);
    const replyRows = [...rows.filter((r) => r.kind === 'ack' && r.extra === 'edited'), ...rows.filter((r) => r.kind === 'reply_fresh')];
    const isRL = (x) => x.outcome === 'failed' && /429|1302/.test(JSON.stringify(x.error ?? ''));
    const failedFinal = fin.settled.filter(isRL).length; // provider rate limit only
    const ceilingFinal = fin.settled.filter((x) => x.outcome === 'failed' && !isRL(x)).length; // e.g. finish-hook 32-cycle ceiling ("internal_error")
    let answered = 0, dupAns = 0, senderOk = 0;
    for (const m of sends) {
      const rs = replyRows.filter((r) => norm(r.text).includes(m.token));
      if (rs.length) answered++;
      if (rs.length > 1) dupAns++;
      if (rs.some((r) => r.text.includes(`@${m.sender}`))) senderOk++;
    }
    const unanswered = sends.length - answered;
    const pfailMsgs = failedFinal ? unanswered : 0;
    const lost = failedFinal ? 0 : unanswered;
    const pfTurns = attempts.reduce((n, a) => n + a.settled.filter(isRL).length, 0);
    const firstReply = rows.filter((r) => r.kind === 'reply_call').map((r) => r.ts).sort((a, b) => a - b)[0];
    const lat = firstReply && sends[0] ? (firstReply - sends[0].sentAt) / 1000 : null;
    const row = { acks: rows.filter((r) => r.kind === 'ack').length, eyes: rows.filter((r) => r.kind === 'eyes').length, cap: rows.filter((r) => r.kind === 'cap_hit').length, nudge: rows.filter((r) => r.kind === 'finish_nudge').length, turns: dump.events.filter((e) => e.type === 'turn_request' && e.instance_id === fin.conv).length, cwin: rows.filter((r) => r.kind === 'c_window').length };
    console.log([plan.burst, sends.length, answered, lost, pfailMsgs, replyRows.length, row.acks, row.eyes, dupAns, row.cap, row.nudge, row.turns, lat == null ? '-' : lat.toFixed(1), attempts.length, row.cwin].join('\t'));
    if (ceilingFinal) S.ceilBursts++;
    else if (!failedFinal) { S.bursts++; S.sent += sends.length; S.answered += answered; S.rows += replyRows.length; if (replyRows.length <= 2) S.within2++; S.turns += row.turns; S.dupAns += dupAns; if (lat != null) S.lat.push(lat); }
    T.ceiling = (T.ceiling ?? 0) + ceilingFinal; T.bursts++; T.sent += sends.length; T.answered += answered; T.lost += lost; T.providerFailedMsgs += pfailMsgs; T.providerFailedTurns += pfTurns; T.reruns += attempts.length - 1;
    T.replyRows += replyRows.length; T.acks += row.acks; T.eyes += row.eyes; T.dupAns += dupAns; T.capHits += row.cap; T.nudges += row.nudge; T.turns += row.turns; T.cwin += row.cwin ? 1 : 0;
    if (replyRows.length <= 2) T.allWithin2++;
    if (!plan.single) { T.multiN++; if (replyRows.length <= 2) T.multiWithin2++; }
    for (const s of fin.sends.filter((s) => s.dup)) { T.dupSent++; if (s.caught) T.dupCaught++; }
    T.senderOk += senderOk; T.senderN += sends.length;
    if (lat != null) (plan.single ? T.latSingle : T.latMulti).push(lat);
    
  }
  aggs.push(T); subs.push(S);
}
console.log('\n=== aggregate');
console.log('arm\tbursts\tsent\tanswered\tlost\tprovFailMsgs\tprovFailTurns\tceilingFails\treruns\treplyRows\tmulti<=2rows\tall<=2rows\tacks\teyes\tdupAns\tcapHits\tnudges\tturns\tturns/burst\tsingleLat med/p90\tmultiLat med/p90\tburstsHittingCwindow\tdupCaught');
for (const T of aggs) console.log([T.arm, T.bursts, T.sent, T.answered, T.lost, T.providerFailedMsgs, T.providerFailedTurns, T.ceiling ?? 0, T.reruns, T.replyRows, `${T.multiWithin2}/${T.multiN}`, `${T.allWithin2}/${T.bursts}`, T.acks, T.eyes, T.dupAns, T.capHits, T.nudges, T.turns, (T.turns / T.bursts).toFixed(1), `${med(T.latSingle)?.toFixed(1)}/${p90(T.latSingle)?.toFixed(1)}`, `${med(T.latMulti)?.toFixed(1)}/${p90(T.latMulti)?.toFixed(1)}`, T.cwin, `${T.dupCaught}/${T.dupSent}`].join('\t'));

console.log('\n=== subset: bursts where the model replied at all (no finish-ceiling failure, no final rate limit)');
console.log('arm\tbursts\tceilingBursts\tsent\tanswered\tlost\treplyRows\tbursts<=2rows\tdupAns\tturns/burst\tlat med/p90');
for (const S of subs) console.log([S.arm, S.bursts, S.ceilBursts, S.sent, S.answered, S.sent - S.answered, S.rows, `${S.within2}/${S.bursts}`, S.dupAns, (S.turns / S.bursts).toFixed(1), `${med(S.lat)?.toFixed(1)}/${p90(S.lat)?.toFixed(1)}`].join('\t'));
