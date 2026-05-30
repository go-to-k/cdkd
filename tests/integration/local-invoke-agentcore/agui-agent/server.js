// Minimal Bedrock AgentCore Runtime AGUI-protocol agent for the cdkl
// invoke-agentcore integ test. Serves the AG-UI HTTP-compatible contract on
// 0.0.0.0:8080:
//   GET  /ping        -> 200 {"status":"Healthy"} so the existing HTTP
//                        readiness wait succeeds (AG-UI builds on the
//                        same 8080 contract as HTTP-protocol agents)
//   POST /invocations -> 200 text/event-stream of three AG-UI events
//                        (RUN_STARTED, MESSAGE_CONTENT, RUN_FINISHED),
//                        exercising the HTTP path's incremental SSE
//                        streaming for the AGUI protocol routing.
// Startup logs go to stderr.
const http = require('node:http');

function streamAguiEvents(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const events = [
    { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' },
    { type: 'MESSAGE_CONTENT', messageId: 'm1', content: 'hello-from-agui' },
    { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' },
  ];
  let i = 0;
  const timer = setInterval(() => {
    if (i < events.length) {
      res.write(`data: ${JSON.stringify(events[i])}\n\n`);
      i += 1;
      return;
    }
    clearInterval(timer);
    res.end();
  }, 50);
  // Host-side abort during the stream: stop firing into a closed socket.
  res.on('close', () => clearInterval(timer));
  res.on('error', () => clearInterval(timer));
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ status: 'Healthy', time_of_last_update: Math.floor(Date.now() / 1000) })
    );
    return;
  }
  if (req.method === 'POST' && req.url === '/invocations') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => streamAguiEvents(res));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(8080, '0.0.0.0', () => {
  console.error('agui fixture listening on 0.0.0.0:8080');
});
