// Local "model" that accepts the request and never sends a byte. Logs connect time.
import http from 'node:http';
http.createServer((req, res) => {
  console.log(new Date().toISOString(), 'stall: request', req.method, req.url);
  req.resume();
  req.on('close', () => console.log(new Date().toISOString(), 'stall: client closed'));
  // never respond
}).listen(5288, () => console.log('stall server on 5288'));
