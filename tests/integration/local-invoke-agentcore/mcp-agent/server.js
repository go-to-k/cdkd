// Minimal Bedrock AgentCore Runtime MCP-protocol agent for the cdkl
// invoke-agentcore integ test. Serves the MCP Streamable-HTTP contract on
// 0.0.0.0:8000 at POST /mcp:
//   initialize                 -> 200 InitializeResult (+ Mcp-Session-Id header)
//   notifications/initialized  -> 202, no body
//   tools/list                 -> 200 a one-tool list
//   tools/call(add_numbers)    -> 200 the sum as text content
// There is no GET /ping (MCP has no health endpoint — readiness is a
// successful initialize). Startup logs go to stderr so the host's stdout
// carries only the cdkl result.
const http = require('node:http');

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJsonRpc(res, id, payload) {
  send(
    res,
    200,
    { 'Content-Type': 'application/json' },
    JSON.stringify({ jsonrpc: '2.0', id, ...payload })
  );
}

// A Streamable-HTTP server MAY answer a request with an SSE stream instead of
// a single JSON object; the response is one `message` event carrying the
// JSON-RPC reply. tools/list uses this path so the integ exercises the
// client's text/event-stream branch end-to-end (tools/call stays JSON).
function sendSseJsonRpc(res, id, payload) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n\n`);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/mcp') {
    send(res, 404, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'not found' }));
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

    if (method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'fixture-session-1' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture-mcp', version: '1.0.0' },
          },
        })
      );
      return;
    }
    if (method === 'notifications/initialized') {
      send(res, 202, {}, '');
      return;
    }
    if (method === 'tools/list') {
      sendSseJsonRpc(res, id, {
        result: {
          tools: [
            {
              name: 'add_numbers',
              description: 'Add two numbers',
              inputSchema: {
                type: 'object',
                properties: { a: { type: 'number' }, b: { type: 'number' } },
              },
            },
          ],
        },
      });
      return;
    }
    if (method === 'tools/call') {
      const args = (params && params.arguments) || {};
      const sum = (Number(args.a) || 0) + (Number(args.b) || 0);
      sendJsonRpc(res, id, {
        result: { content: [{ type: 'text', text: String(sum) }], isError: false },
      });
      return;
    }
    sendJsonRpc(res, id, { error: { code: -32601, message: 'Method not found' } });
  });
});

server.listen(8000, '0.0.0.0', () => {
  console.error('mcp fixture listening on 0.0.0.0:8000');
});
