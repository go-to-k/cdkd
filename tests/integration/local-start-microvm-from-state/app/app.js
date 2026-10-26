// A dependency-free MicroVM application for `cdkd local start-microvm --from-state`'s
// integ fixture (a copy of local-start-microvm's app that also echoes the
// intrinsic-valued env vars). It serves the lifecycle hooks on 9001 and echoes what it saw on
// 8080 and 9000, so verify.sh can assert the hook order, the run payload and
// the port routing from the outside.
const http = require('http');
const crypto = require('crypto');

const HOOK_PREFIX = '/aws/lambda-microvms/runtime/v1/';
const state = {
  readyAttempts: 0,
  hooks: [],
  microvmId: null,
  runHookPayload: null,
  greeting: process.env.GREETING || null,
};

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

http
  .createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.method !== 'POST' || !req.url.startsWith(HOOK_PREFIX)) return send(res, 404, {});
    const hook = req.url.slice(HOOK_PREFIX.length);
    if (hook === 'ready') {
      state.readyAttempts += 1;
      // NEVER_READY images stay "not yet" forever; the others become ready on
      // the third poll, so the 503 retry path is exercised.
      if (process.env.NEVER_READY === '1' || state.readyAttempts < 3) {
        console.log(`HOOK ready -> 503 (attempt ${state.readyAttempts})`);
        return send(res, 503, { ready: false });
      }
    }
    if (hook === 'run') {
      const parsed = JSON.parse(body || '{}');
      state.microvmId = parsed.microvmId ?? null;
      state.runHookPayload = parsed.runHookPayload ?? null;
    }
    state.hooks.push(hook);
    console.log(`HOOK ${hook} -> 200 microvm=${state.microvmId ?? '-'}`);
    return send(res, 200, { ok: true });
  })
  .listen(9001, '0.0.0.0');

// A minimal WebSocket echo (RFC 6455 text frames, no extensions) for the
// upgrade arm: the first frame reports the Sec-WebSocket-Protocol header the
// app received, then every client text frame is echoed back.
function wsFrame(text) {
  const payload = Buffer.from(text);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x81, len]) : Buffer.from([0x81, 126, len >> 8, len & 0xff]);
  return Buffer.concat([head, payload]);
}

function handleUpgrade(req, socket) {
  const accept = crypto
    .createHash('sha1')
    .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.write(
    wsFrame(JSON.stringify({ subprotocolHeader: req.headers['sec-websocket-protocol'] ?? null }))
  );
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      buf = buf.subarray(off + 4 + len);
      if (opcode === 0x8) return socket.end(Buffer.from([0x88, 0]));
      if (opcode === 0x1) socket.write(wsFrame(`echo:${data.toString()}`));
    }
  });
  socket.on('error', () => undefined);
}

for (const port of [8080, 9000]) {
  http
    .createServer(async (req, res) => {
      await readBody(req);
      send(res, 200, {
        port,
        path: req.url,
        microvmId: state.microvmId,
        runHookPayload: state.runHookPayload,
        greeting: state.greeting,
        // The intrinsic-valued EnvironmentVariables the --from-state arm checks
        // (null when the variable did not reach the container).
        env: {
          BUCKET_NAME: process.env.BUCKET_NAME ?? null,
          BUCKET_ARN: process.env.BUCKET_ARN ?? null,
          PARAM_NAME: process.env.PARAM_NAME ?? null,
        },
        readyAttempts: state.readyAttempts,
        hooks: state.hooks,
        proxyHeaders: Object.keys(req.headers).filter((h) => h.startsWith('x-aws-proxy-')),
      });
    })
    .on('upgrade', handleUpgrade)
    .listen(port, '0.0.0.0');
}

console.log('app listening on 8080, 9000 and hooks on 9001');
