// Header-less WebSocket probe for the `cdkl start-agentcore` integ test.
//
// Uses the Node global `WebSocket` (browser-compatible API) — which, like a
// browser, CANNOT set custom request headers. This is the whole point: it
// proves the host bridge injects the AgentCore session-id on the container
// /ws upgrade so a header-less client can hold a session.
//
// Drives the agent's /ws REPL mode:
//   1. send `{"loop":true}` as the first frame
//   2. assert the reply echoes our frame AND carries a non-null sessionId
//      (the bridge-injected UUID — we never sent one)
//   3. send a second frame `hello-2`
//   4. assert the agent echoes it back as `loop-echo:hello-2`
//
// Prints `PROBE_OK` and exits 0 on success; prints a reason and exits 1
// otherwise (including a hard timeout).
//
// Usage: node ws-probe.mjs ws://127.0.0.1:<port>/ws

const url = process.argv[2];
if (!url) {
  console.error('usage: node ws-probe.mjs <ws-url>');
  process.exit(1);
}

const fail = (msg) => {
  console.error(`PROBE_FAIL: ${msg}`);
  process.exit(1);
};

const timer = setTimeout(() => fail('timed out after 15s'), 15000);

const ws = new WebSocket(url);
let stage = 0;

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ loop: true }));
});

ws.addEventListener('message', (ev) => {
  const text = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf-8');
  if (stage === 0) {
    let reply;
    try {
      reply = JSON.parse(text);
    } catch {
      return fail(`first frame was not JSON: ${text}`);
    }
    if (reply.ws !== true) return fail(`first frame missing ws:true: ${text}`);
    if (!reply.sessionId) return fail(`bridge did not inject a session id: ${text}`);
    stage = 1;
    ws.send('hello-2');
    return;
  }
  if (stage === 1) {
    if (text !== 'loop-echo:hello-2') return fail(`expected loop-echo:hello-2, got: ${text}`);
    clearTimeout(timer);
    console.log('PROBE_OK');
    ws.close();
    process.exit(0);
  }
});

ws.addEventListener('error', (ev) => fail(`socket error: ${ev.message ?? ev.type ?? 'unknown'}`));
ws.addEventListener('close', () => {
  if (stage < 2) fail('socket closed before the probe completed');
});
