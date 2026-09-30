const base = process.env.BASE ?? 'http://localhost:5199';
const r = await (await fetch(`${base}/rows`)).json();
const f = (x) => x.map((o) => JSON.stringify(o)).join('\n    ');
console.log(`tool_calls=${r.tool_calls.length}\n    ${f(r.tool_calls)}\nreplies=${r.replies.length}\n    ${f(r.replies)}`);
