// Minimal AgentCore Runtime container for the G2 from-state integ.
// Echoes the injected env vars in the response body so the verify.sh
// can assert that --from-state substituted the intrinsic BUCKET_NAME
// to the real deployed S3 bucket name, and that the literal
// STATIC_VALUE passed through unchanged.
const http = require('node:http');

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Healthy' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/invocations') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let event;
      try {
        event = JSON.parse(body || '{}');
      } catch {
        event = {};
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          echoed: event,
          env: {
            BUCKET_NAME: process.env.BUCKET_NAME ?? 'unset',
            STATIC_VALUE: process.env.STATIC_VALUE ?? 'unset',
          },
        })
      );
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(8080, '0.0.0.0', () => {
  console.error('agent listening on 0.0.0.0:8080');
});
