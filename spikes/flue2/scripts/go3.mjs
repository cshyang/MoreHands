// node scripts/go3.mjs <id> <body text> <model>  -- custom body against the Retry agent
const [id, text, model] = process.argv.slice(2);
const res = await fetch('http://localhost:5199/go2', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ agent: 'retry', id, message: { kind: 'signal', type: 'slack.message', body: text, attributes: { sender: 'u1', model } } }),
});
console.log(res.status, await res.text());
