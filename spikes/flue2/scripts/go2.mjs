// node scripts/go2.mjs <id> [agent=retry|once] [key|-] [model]
const [id, agent = 'retry', key, model] = process.argv.slice(2);
const body = {
  agent,
  id,
  message: { kind: 'signal', type: 'slack.message', body: 'Please do the task: call slow_step, then post_reply.', attributes: { sender: 'u1', ...(model ? { model } : {}) } },
  ...(key && key !== '-' ? { idempotencyKey: key } : {}),
};
const res = await fetch('http://localhost:5199/go2', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
console.log(res.status, await res.text());
