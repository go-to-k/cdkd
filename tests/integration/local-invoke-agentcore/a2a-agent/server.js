// Minimal Bedrock AgentCore Runtime A2A-protocol agent for the cdkl
// invoke-agentcore integ test. Serves the Agent2Agent JSON-RPC 2.0 contract on
// 0.0.0.0:9000 at POST / (the root):
//   agent/getCard       -> 200 a minimal agent card
//   tasks/send          -> 200 echoes the task id + message back
//   anything else       -> a JSON-RPC -32601 "Method not found" error
// Startup logs go to stderr so the host's stdout carries only the cdkl result.
const http = require('node:http');

function sendJsonRpc(res, id, payload) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, ...payload }));
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    let msg;
    try {
      msg = JSON.parse(body || '{}');
    } catch {
      msg = {};
    }
    const { id, method, params } = msg;

    if (method === 'agent/getCard') {
      sendJsonRpc(res, id, {
        result: {
          name: 'fixture-a2a-agent',
          description: 'integ-test A2A agent',
          version: '1.0.0',
          url: 'http://localhost:9000',
          capabilities: { streaming: false },
        },
      });
      return;
    }
    if (method === 'tasks/send') {
      const taskId = (params && params.id) || 'unknown';
      const message = (params && params.message) || null;
      sendJsonRpc(res, id, {
        result: { id: taskId, status: { state: 'completed' }, echoedMessage: message },
      });
      return;
    }
    sendJsonRpc(res, id, { error: { code: -32601, message: 'Method not found' } });
  });
});

server.listen(9000, '0.0.0.0', () => {
  console.error('a2a fixture listening on 0.0.0.0:9000');
});
