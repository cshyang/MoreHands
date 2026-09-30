// node scripts/burst-report.mjs out.json
import fs from 'node:fs';
const { plans, dump } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const norm = (t) => t.toLowerCase().replace(/[\u2080-\u2089]/g, (c) => String(c.charCodeAt(0) - 0x2080)); // H₂O -> h2o
const lines = [];
const tot = { sent: 0, answered: 0, lost: 0, dupAns: 0, loops: 0, own: 0, dangling: 0, senderOk: 0, senderN: 0, dupCaught: 0, dupPlanned: 0, over2: 0 };
for (const p of plans) {
  const rows = dump.rows.filter((r) => r.conv === p.conv);
  const msgs = dump.msgs.filter((m) => m.burst === p.burst);
  const acks = rows.filter((r) => r.kind === 'ack'), eyes = rows.filter((r) => r.kind === 'eyes');
  const replyRows = [...acks.filter((r) => r.extra === 'edited'), ...rows.filter((r) => r.kind === 'reply_fresh')];
  const dangling = acks.filter((r) => r.extra !== 'edited').length;
  const replyCalls = rows.filter((r) => r.kind === 'reply_call').length;
  // loops: >2 reply calls in one submission (tool_start events carry the submission id)
  const subs = {};
  for (const e of dump.events.filter((e) => e.instance_id === p.conv && e.type === 'tool_start')) subs[e.submission_id] = (subs[e.submission_id] ?? 0) + 1;
  const loops = Object.values(subs).some((n) => n > 2) ? 1 : 0;
  const runaway = replyCalls > p.msgs.length + 1 ? 1 : 0; // more reply calls than messages sent (+1)
  let answered = 0, dupAns = 0, senderOk = 0;
  for (const m of p.msgs) {
    const rs = replyRows.filter((r) => norm(r.text).includes(m.token));
    if (rs.length) answered++;
    if (rs.length > 1) dupAns++;
    if (rs.some((r) => r.text.includes(`@${m.sender}`))) senderOk++;
  }
  // own turn without ack: message dispatched on the eyes path whose submission got its own submission_running
  const running = new Set(dump.events.filter((e) => e.type === 'submission_running').map((e) => e.submission_id));
  const own = msgs.filter((m) => m.path === 'eyes' && running.has(m.submission_id)).length;
  const startRows = rows.filter((r) => r.kind === 'start').length;
  const lost = p.msgs.length - answered;
  const row = { burst: p.burst, sent: p.msgs.length, answered, lost, replyRows: replyRows.length, acks: acks.length, eyes: eyes.length, dupAns, replyCalls, loops, runaway, own, dangling, starts: startRows, dup: p.dupOf >= 0 ? 'y' : '' };
  lines.push(row);
  tot.sent += row.sent; tot.answered += answered; tot.lost += lost; tot.dupAns += dupAns; tot.loops += loops; tot.runaway = (tot.runaway ?? 0) + runaway; tot.lostBursts = (tot.lostBursts ?? 0) + (lost ? 1 : 0); tot.own += own; tot.dangling += dangling;
  tot.senderOk += senderOk; tot.senderN += p.msgs.length; if (replyRows.length > 2) tot.over2++;
}
console.log('burst sent answered lost replyRows acks eyes dupAns replyCalls loops runaway ownTurnNoAck danglingAck starts dup');
for (const r of lines) console.log([r.burst, r.sent, r.answered, r.lost, r.replyRows, r.acks, r.eyes, r.dupAns, r.replyCalls, r.loops, r.runaway, r.own, r.dangling, r.starts, r.dup].join('\t'));
console.log(JSON.stringify({ ...tot, burstsWithAtMost2ReplyRows: `${lines.length - tot.over2}/${lines.length}` }));
