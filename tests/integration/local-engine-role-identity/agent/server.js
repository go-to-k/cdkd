// Minimal AgentCore Runtime agent for the local-engine-role-identity integ.
// Serves the HTTP contract on 0.0.0.0:8080:
//   GET  /ping        -> 200 {"status":"Healthy"}
//   POST /invocations -> 200 {"akid": <AWS_ACCESS_KEY_ID of this container, or null>}
// Only the access key ID is echoed, never the secret key or the token.
const http = require('node:http');

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'Healthy' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/invocations') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ akid: process.env.AWS_ACCESS_KEY_ID || null }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(8080, '0.0.0.0', () => process.stderr.write('agent listening on 8080\n'));
