// Minimal Bedrock AgentCore Runtime agent for the cdkl invoke-agentcore integ
// test. Serves the AgentCore HTTP contract on 0.0.0.0:8080:
//   GET  /ping        -> 200 {"status":"Healthy", ...}
//   POST /invocations -> by default echoes the request body, the received
//                        session-id header, the received Authorization header,
//                        and the injected GREETING env var. When the event has
//                        {"stream": true}, instead responds with a
//                        text/event-stream body emitting a few SSE frames with
//                        small gaps, to exercise incremental streaming.
//   GET  /ws (upgrade) -> bidirectional WebSocket: on the first received frame,
//                        sends one JSON frame echoing the frame + session-id +
//                        Authorization + GREETING, then a second text frame, then
//                        closes — exercising `cdkl invoke-agentcore --ws`.
//                        When the first frame's payload contains {"loop": true},
//                        instead enters a REPL mode: echoes each subsequent text
//                        frame as `loop-echo:<payload>` and stays open until the
//                        client closes — exercising `--ws-interactive`.
// The WebSocket handshake + framing is implemented over the built-in `http`
// `upgrade` event so the container needs no npm deps.
// Startup logs go to stderr so the host's stdout carries only the cdkl
// result line.
const http = require('node:http');
const crypto = require('node:crypto');

const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function streamSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const tokens = ['hello', 'from', 'sse'];
  let i = 0;
  const timer = setInterval(() => {
    if (i < tokens.length) {
      res.write(`data: {"token":"${tokens[i]}"}\n\n`);
      i += 1;
      return;
    }
    res.write('data: [DONE]\n\n');
    clearInterval(timer);
    res.end();
  }, 50);
}

// Encode a single unmasked text frame (server -> client). Payloads here are
// small, so only the 7-bit and 16-bit length forms are needed.
function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf-8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else {
    header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  }
  return Buffer.concat([header, payload]);
}

function encodeCloseFrame() {
  // FIN + opcode 0x8 (close), zero-length payload.
  return Buffer.from([0x88, 0x00]);
}

// Decode the FIRST complete frame in `buf`. Returns { opcode, payload,
// frameLength } or null when the buffer does not yet hold a full frame (the
// caller keeps accumulating until it does). `frameLength` is the number of
// bytes the frame consumed, so the caller can advance past it. Client frames
// are masked.
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    len = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }
  let maskKey;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (masked) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
  }
  return { opcode, payload, frameLength: offset + len };
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  let buf = Buffer.alloc(0);
  let firstFrameSeen = false;
  let loopMode = false;
  socket.on('data', (chunk) => {
    // A frame can span TCP reads (or several frames can share one read), so
    // accumulate and drain complete frames as they arrive.
    buf = Buffer.concat([buf, chunk]);
    let frame;
    while ((frame = decodeFrame(buf)) !== null) {
      buf = buf.subarray(frame.frameLength);
      if (frame.opcode === 0x8) {
        socket.end();
        return;
      }
      if (frame.opcode !== 0x1) continue; // skip ping/pong/continuation control frames
      const payloadText = frame.payload.toString('utf-8');
      if (!firstFrameSeen) {
        firstFrameSeen = true;
        let echoed;
        try {
          echoed = JSON.parse(payloadText || '{}');
        } catch {
          echoed = payloadText;
        }
        const reply = JSON.stringify({
          ws: true,
          echoed,
          sessionId: req.headers[SESSION_HEADER] ?? null,
          authorization: req.headers['authorization'] ?? null,
          greeting: process.env.GREETING ?? 'unset',
        });
        socket.write(encodeTextFrame(reply));
        if (echoed && typeof echoed === 'object' && echoed.loop === true) {
          // REPL mode: echo each subsequent text frame as `loop-echo:<text>`
          // and stay open until the client sends a close frame.
          loopMode = true;
          continue;
        }
        socket.write(encodeTextFrame('ws-frame-2'));
        socket.write(encodeCloseFrame());
        socket.end();
        return;
      }
      if (loopMode) {
        socket.write(encodeTextFrame(`loop-echo:${payloadText}`));
      }
    }
  });
  socket.on('error', () => socket.destroy());
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Healthy', time_of_last_update: Math.floor(Date.now() / 1000) }));
    return;
  }

  if (req.method === 'POST' && req.url === '/invocations') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let echoed;
      try {
        echoed = JSON.parse(body || '{}');
      } catch {
        echoed = body;
      }
      if (echoed && typeof echoed === 'object' && echoed.stream === true) {
        streamSse(res);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          echoed,
          sessionId: req.headers[SESSION_HEADER] ?? null,
          authorization: req.headers['authorization'] ?? null,
          greeting: process.env.GREETING ?? 'unset',
        })
      );
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.on('upgrade', (req, socket) => {
  if (req.url === '/ws') {
    handleUpgrade(req, socket);
    return;
  }
  socket.destroy();
});

server.listen(8080, '0.0.0.0', () => {
  console.error('agent listening on 0.0.0.0:8080');
});
