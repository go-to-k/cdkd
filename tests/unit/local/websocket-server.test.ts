/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { attachWebSocketServer, type AttachOptions } from '../../../src/local/websocket-server.js';
// Namespace import so vi.spyOn(websocketBody, 'bufferToBody') intercepts
// the same export the production code reads via its namespace import
// (Issue #537 item 6).
import * as websocketBody from '../../../src/local/websocket-body.js';
import { ConsoleLogger } from '../../../src/utils/logger.js';
import type { DiscoveredWebSocketApi } from '../../../src/local/websocket-route-discovery.js';
import type { ContainerPool, ContainerHandle } from '../../../src/local/container-pool.js';

// `invokeRie` is mocked at the module boundary so tests don't actually
// spin up docker / RIE. Each test queues per-call responses via the
// helper below.
vi.mock('../../../src/local/rie-client.js', async () => {
  const queue: Array<{ payload: unknown; raw: string }> = [];
  return {
    invokeRie: vi.fn(async () => {
      if (queue.length === 0) return { payload: {}, raw: '{}' };
      return queue.shift()!;
    }),
    invokeRieStreaming: vi.fn(),
    waitForRieReady: vi.fn(async () => undefined),
    parseStreamingPrelude: vi.fn(),
    STREAM_PRELUDE_MAX_BYTES: 0,
    STREAM_BODY_MAX_BYTES: 0,
    __queueInvokeResult: (payload: unknown) =>
      queue.push({ payload, raw: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
    __resetQueue: () => {
      queue.length = 0;
    },
  };
});

const rieModule = (await import('../../../src/local/rie-client.js')) as unknown as {
  invokeRie: ReturnType<typeof vi.fn>;
  __queueInvokeResult: (payload: unknown) => void;
  __resetQueue: () => void;
};

function buildFakePool(): ContainerPool {
  const acquire = vi.fn(
    async (logicalId: string): Promise<ContainerHandle> => ({
      logicalId,
      containerId: 'cid-' + logicalId,
      containerName: 'name-' + logicalId,
      hostPort: 9999,
      containerHost: '127.0.0.1',
      stopLogStream: () => undefined,
    })
  );
  const release = vi.fn();
  const dispose = vi.fn(async () => undefined);
  return { acquire, release, dispose } as unknown as ContainerPool;
}

function buildApi(routes: Array<{ routeKey: string; lambda?: string }>): DiscoveredWebSocketApi {
  return {
    apiLogicalId: 'WsApi',
    apiStackName: 'S',
    declaredAt: 'S/WsApi',
    routeSelectionExpression: '$request.body.action',
    stage: 'prod',
    routes: routes.map((r) => ({
      routeKey: r.routeKey,
      targetLambdaLogicalId: r.lambda ?? 'Handler',
      lambdaStackName: 'S',
      declaredAt: 'S/RouteFor' + r.routeKey,
    })),
  };
}

async function startTestServer(opts: {
  apis: AttachOptions['apis'];
  pool: ContainerPool;
}): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const attached = attachWebSocketServer({
    httpServer: server,
    apis: opts.apis,
    pool: opts.pool,
    rieTimeoutMs: 2000,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    close: async () => {
      await attached.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

function openWebSocket(port: number, path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function awaitMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once('message', (msg) => resolve(msg.toString('utf-8')));
  });
}

function awaitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf-8') }));
  });
}

/**
 * Poll `predicate` every 10ms until it returns true or `timeoutMs`
 * elapses. Resolves either way; the caller checks the spied mock to
 * decide pass/fail. Replaces fixed `setTimeout(r, 100)` waits with a
 * race-free wait — under CI load the 100ms budget can be exhausted by
 * scheduler jitter (Issue #537 item 11).
 */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('attachWebSocketServer end-to-end', () => {
  beforeAll(() => {
    rieModule.__resetQueue();
  });
  beforeEach(() => {
    rieModule.__resetQueue();
    rieModule.invokeRie.mockClear();
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('admits the client when $connect Lambda returns statusCode: 200', async () => {
    rieModule.__resetQueue();
    rieModule.__queueInvokeResult({ statusCode: 200 });

    const pool = buildFakePool();
    const api = buildApi([{ routeKey: '$connect' }]);
    const { port, close } = await startTestServer({
      apis: [{ api, apiPath: '/prod' }],
      pool,
    });
    try {
      const ws = await openWebSocket(port, '/prod');
      // $connect Lambda invoked
      expect(rieModule.invokeRie).toHaveBeenCalledTimes(1);
      ws.close();
      await awaitClose(ws);
    } finally {
      await close();
    }
  });

  it('denies the client when $connect Lambda returns non-2xx', async () => {
    rieModule.__resetQueue();
    rieModule.__queueInvokeResult({ statusCode: 401 });

    const pool = buildFakePool();
    const api = buildApi([{ routeKey: '$connect' }]);
    const { port, close } = await startTestServer({
      apis: [{ api, apiPath: '/prod' }],
      pool,
    });
    try {
      const ws = await openWebSocket(port, '/prod');
      const closure = await awaitClose(ws);
      expect(closure.code).toBe(1008);
    } finally {
      await close();
    }
  });

  it('rejects upgrades on unknown paths with HTTP 404', async () => {
    rieModule.__resetQueue();
    const pool = buildFakePool();
    const api = buildApi([{ routeKey: '$connect' }]);
    const { port, close } = await startTestServer({
      apis: [{ api, apiPath: '/prod' }],
      pool,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/wrong`);
        ws.on('open', () => reject(new Error('upgrade should have failed')));
        ws.on('error', () => resolve());
        ws.on('unexpected-response', () => resolve());
        ws.on('close', () => resolve());
      });
    } finally {
      await close();
    }
  });

  it('dispatches messages to $default when selection-expression value misses', async () => {
    rieModule.__resetQueue();
    rieModule.__queueInvokeResult({ statusCode: 200 }); // $connect
    rieModule.__queueInvokeResult({}); // $default invocation

    const pool = buildFakePool();
    const api = buildApi([
      { routeKey: '$connect', lambda: 'ConnectFn' },
      { routeKey: '$default', lambda: 'DefaultFn' },
    ]);
    const { port, close } = await startTestServer({
      apis: [{ api, apiPath: '/prod' }],
      pool,
    });
    try {
      const ws = await openWebSocket(port, '/prod');
      // The 1st invokeRie call is $connect — wait, then send a JSON
      // frame whose `action` field doesn't match any registered route.
      ws.send(JSON.stringify({ action: 'unknown' }));
      // Wait one tick for dispatch
      await new Promise((r) => setTimeout(r, 100));
      // Should have invoked Default (2 total: connect + default)
      expect(rieModule.invokeRie).toHaveBeenCalledTimes(2);
      const lastCall = rieModule.invokeRie.mock.calls.at(-1) as any;
      // 3rd arg (event) carries the routeKey
      expect(lastCall[2].requestContext.routeKey).toBe('$default');
      ws.close();
      await awaitClose(ws);
    } finally {
      await close();
    }
  });

  it('dispatches messages to the matching custom route', async () => {
    rieModule.__resetQueue();
    rieModule.__queueInvokeResult({ statusCode: 200 }); // $connect
    rieModule.__queueInvokeResult({}); // sendMessage invocation

    const pool = buildFakePool();
    const api = buildApi([
      { routeKey: '$connect', lambda: 'ConnectFn' },
      { routeKey: 'sendMessage', lambda: 'SendFn' },
    ]);
    const { port, close } = await startTestServer({
      apis: [{ api, apiPath: '/prod' }],
      pool,
    });
    try {
      const ws = await openWebSocket(port, '/prod');
      ws.send(JSON.stringify({ action: 'sendMessage', text: 'hi' }));
      await new Promise((r) => setTimeout(r, 100));
      expect(rieModule.invokeRie).toHaveBeenCalledTimes(2);
      const lastCall = rieModule.invokeRie.mock.calls.at(-1) as any;
      expect(lastCall[2].requestContext.routeKey).toBe('sendMessage');
      expect(lastCall[2].body).toContain('hi');
      ws.close();
      await awaitClose(ws);
    } finally {
      await close();
    }
  });

  it('fires $disconnect Lambda on socket close', async () => {
    rieModule.__resetQueue();
    rieModule.__queueInvokeResult({ statusCode: 200 }); // $connect
    rieModule.__queueInvokeResult({}); // $disconnect

    const pool = buildFakePool();
    const api = buildApi([
      { routeKey: '$connect', lambda: 'ConnectFn' },
      { routeKey: '$disconnect', lambda: 'DisconnectFn' },
    ]);
    const { port, close } = await startTestServer({
      apis: [{ api, apiPath: '/prod' }],
      pool,
    });
    try {
      const ws = await openWebSocket(port, '/prod');
      ws.close(1000, 'goodbye');
      await awaitClose(ws);
      // Give the dispatch loop a tick to fire $disconnect
      await new Promise((r) => setTimeout(r, 100));
      expect(rieModule.invokeRie).toHaveBeenCalledTimes(2);
      const lastCall = rieModule.invokeRie.mock.calls.at(-1) as any;
      expect(lastCall[2].requestContext.routeKey).toBe('$disconnect');
      expect(lastCall[2].requestContext.disconnectStatusCode).toBe(1000);
    } finally {
      await close();
    }
  });

  it('registry exposes the connection so @connections POST can reach it', async () => {
    rieModule.__resetQueue();
    rieModule.__queueInvokeResult({ statusCode: 200 }); // $connect

    const pool = buildFakePool();
    const api = buildApi([{ routeKey: '$connect' }]);
    const server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const attached = attachWebSocketServer({
      httpServer: server,
      apis: [{ api, apiPath: '/prod' }],
      pool,
      rieTimeoutMs: 2000,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const ws = await openWebSocket(port, '/prod');
      // Wait briefly for registry insertion (happens after $connect Lambda resolves)
      await new Promise((r) => setTimeout(r, 100));
      expect(attached.registry.size()).toBe(1);
      const entry = attached.registry.list()[0]!;
      // Send via registry — should land on the client
      const incoming = awaitMessage(ws);
      entry.socket.send('hello-from-management');
      expect(await incoming).toBe('hello-from-management');
      ws.close();
      await awaitClose(ws);
    } finally {
      await attached.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
  });

  // #531 m1-test: Node Lambda runtime emits `{errorMessage, errorType,
  // stackTrace}` envelopes when a handler throws (or hits an unhandled
  // promise rejection). The $connect verdict path at
  // `invokeRouteAndDecideAuth` (websocket-server.ts) must treat this
  // shape as a deny — AWS-deployed WebSocket APIs do not admit
  // connections whose `$connect` handler threw. The
  // `errorMessage`-without-`statusCode` precedence has no prior unit
  // coverage; this test pins it.
  it('denies $connect when handler returns Lambda error envelope (errorMessage without statusCode)', async () => {
    rieModule.__resetQueue();
    rieModule.__queueInvokeResult({
      errorMessage: 'Cannot read properties of undefined',
      errorType: 'TypeError',
      stackTrace: ['at handler (/var/task/index.js:5:1)'],
    });

    const pool = buildFakePool();
    const api = buildApi([{ routeKey: '$connect' }]);
    const { port, close } = await startTestServer({
      apis: [{ api, apiPath: '/prod' }],
      pool,
    });
    try {
      const ws = await openWebSocket(port, '/prod');
      const closure = await awaitClose(ws);
      expect(closure.code).toBe(1008);
    } finally {
      await close();
    }
  });

  // #531 m1-test (cont.): when both `statusCode` AND `errorMessage` are
  // present, `statusCode` wins — matches AWS-deployed behavior for
  // handlers that build a response payload after catching their own
  // exception.
  it('admits $connect when statusCode: 200 is present even alongside errorMessage', async () => {
    rieModule.__resetQueue();
    rieModule.__queueInvokeResult({
      statusCode: 200,
      errorMessage: 'recoverable',
    });

    const pool = buildFakePool();
    const api = buildApi([{ routeKey: '$connect' }]);
    const { port, close } = await startTestServer({
      apis: [{ api, apiPath: '/prod' }],
      pool,
    });
    try {
      const ws = await openWebSocket(port, '/prod');
      await new Promise((r) => setTimeout(r, 50));
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      await awaitClose(ws);
    } finally {
      await close();
    }
  });

  it('admits $connect with no statusCode / no errorMessage (lenient AWS default)', async () => {
    rieModule.__resetQueue();
    rieModule.__queueInvokeResult({});

    const pool = buildFakePool();
    const api = buildApi([{ routeKey: '$connect' }]);
    const { port, close } = await startTestServer({
      apis: [{ api, apiPath: '/prod' }],
      pool,
    });
    try {
      const ws = await openWebSocket(port, '/prod');
      // Should NOT close immediately with 1008
      await new Promise((r) => setTimeout(r, 50));
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      await awaitClose(ws);
    } finally {
      await close();
    }
  });

  it('admits clients when the API has no $connect route', async () => {
    rieModule.__resetQueue();

    const pool = buildFakePool();
    const api = buildApi([{ routeKey: '$default', lambda: 'DefaultFn' }]);
    const { port, close } = await startTestServer({
      apis: [{ api, apiPath: '/prod' }],
      pool,
    });
    try {
      const ws = await openWebSocket(port, '/prod');
      await new Promise((r) => setTimeout(r, 50));
      // No $connect → no Lambda invocation at all on connect.
      expect(rieModule.invokeRie).toHaveBeenCalledTimes(0);
      ws.close();
      await awaitClose(ws);
    } finally {
      await close();
    }
  });
});

// B3 (#526) end-to-end: binary frames must surface as
// `isBase64Encoded: true` on the message event so handlers can correctly
// decode via `Buffer.from(event.body, 'base64')`. Pre-fix the flag was
// hardcoded `false` and every binary byte > 0x7F silently corrupted.
describe('binary frame dispatch (B3 end-to-end)', () => {
  beforeEach(() => {
    rieModule.__resetQueue();
    rieModule.invokeRie.mockClear();
  });
  it('surfaces isBase64Encoded=true for binary message frames', async () => {
    rieModule.__resetQueue();
    rieModule.__queueInvokeResult({ statusCode: 200 }); // $connect
    rieModule.__queueInvokeResult({}); // $default

    const pool = buildFakePool();
    const api = buildApi([
      { routeKey: '$connect', lambda: 'ConnectFn' },
      { routeKey: '$default', lambda: 'DefaultFn' },
    ]);
    const { port, close } = await startTestServer({
      apis: [{ api, apiPath: '/prod' }],
      pool,
    });
    try {
      const ws = await openWebSocket(port, '/prod');
      // Send a binary frame containing non-ASCII bytes.
      const binaryPayload = Buffer.from([0xff, 0xfe, 0x80, 0x42, 0x00]);
      ws.send(binaryPayload, { binary: true });
      // Poll for the $default dispatch (Issue #537 item 11 — replaces
      // a fixed 100ms setTimeout that CI scheduler jitter could
      // exhaust). 1000ms ceiling matches the issue's recommendation.
      await waitFor(() => rieModule.invokeRie.mock.calls.length >= 2);
      // 2 invokeRie calls: $connect + $default (binary message).
      expect(rieModule.invokeRie).toHaveBeenCalledTimes(2);
      const messageCall = rieModule.invokeRie.mock.calls.at(-1) as any;
      const event = messageCall[2];
      expect(event.isBase64Encoded).toBe(true);
      // Body must be the base64-encoded form, NOT a UTF-8 best-effort
      // decode (which would corrupt 0xFF / 0xFE / 0x80).
      expect(event.body).toBe(binaryPayload.toString('base64'));
      // Round-trip must preserve every byte.
      expect(Buffer.from(event.body, 'base64').equals(binaryPayload)).toBe(true);
      ws.close();
      await awaitClose(ws);
    } finally {
      await close();
    }
  });

  it('surfaces isBase64Encoded=false for text frames (preserves pre-fix behavior)', async () => {
    rieModule.__resetQueue();
    rieModule.__queueInvokeResult({ statusCode: 200 });
    rieModule.__queueInvokeResult({});

    const pool = buildFakePool();
    const api = buildApi([
      { routeKey: '$connect', lambda: 'ConnectFn' },
      { routeKey: '$default', lambda: 'DefaultFn' },
    ]);
    const { port, close } = await startTestServer({
      apis: [{ api, apiPath: '/prod' }],
      pool,
    });
    try {
      const ws = await openWebSocket(port, '/prod');
      ws.send('{"action":"unknown","text":"hello"}'); // text frame
      // Poll until $default dispatch lands (Issue #537 item 11).
      await waitFor(() => rieModule.invokeRie.mock.calls.length >= 2);
      const messageCall = rieModule.invokeRie.mock.calls.at(-1) as any;
      expect(messageCall[2].isBase64Encoded).toBe(false);
      expect(messageCall[2].body).toBe('{"action":"unknown","text":"hello"}');
      ws.close();
      await awaitClose(ws);
    } finally {
      await close();
    }
  });
});

// B4 (#526): the $connect-deny path no longer leaks the message listener
// after the policy-violation close frame. Verified structurally — frames
// arriving during the close-handshake window are NOT dispatched.
describe('$connect-deny listener safety (B4 regression guard)', () => {
  beforeEach(() => {
    rieModule.__resetQueue();
    rieModule.invokeRie.mockClear();
  });
  it('does NOT dispatch messages sent after a $connect deny', async () => {
    rieModule.__resetQueue();
    rieModule.__queueInvokeResult({ statusCode: 403 }); // $connect deny

    const pool = buildFakePool();
    const api = buildApi([
      { routeKey: '$connect', lambda: 'ConnectFn' },
      { routeKey: '$default', lambda: 'DefaultFn' },
    ]);
    const { port, close } = await startTestServer({
      apis: [{ api, apiPath: '/prod' }],
      pool,
    });

    // Issue #537 item 6: install a spy on the bufferToBody export the
    // production code reads via its namespace import. A frame that
    // arrived during the close-handshake window MUST NOT reach
    // bufferToBody — the pre-fix bug was the listener allocating
    // Buffer.toString output on every frame even after deny.
    const bodySpy = vi.spyOn(websocketBody, 'bufferToBody');
    try {
      // Connect with an immediate send race; the client gets denied
      // but might fire send before the close lands.
      const ws = new WebSocket(`ws://127.0.0.1:${port}/prod`);
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          // Spam frames before the deny lands.
          for (let i = 0; i < 50; i += 1) {
            try {
              ws.send(`frame-${i}`);
            } catch {
              break;
            }
          }
          resolve();
        });
        ws.on('error', () => resolve()); // close fires shortly after
        setTimeout(reject, 2000);
      });
      await awaitClose(ws);
      // Wait an extra tick for any straggler dispatches.
      await new Promise((r) => setTimeout(r, 50));
      // Only the $connect Lambda was invoked; NONE of the 50 frames
      // dispatched to $default (pre-fix the leaked listener would
      // have called bufferToBody + dispatchMessage for every frame in
      // the close-handshake window).
      expect(rieModule.invokeRie).toHaveBeenCalledTimes(1);
      const onlyCall = rieModule.invokeRie.mock.calls[0] as any;
      expect(onlyCall[2].requestContext.routeKey).toBe('$connect');
      // Item 6 assertion: bufferToBody was never called for any of the
      // denied frames. The pre-listener stores raw refs ONLY; no
      // allocation work runs until the admit path (which we never
      // reached). Pins the structural fix.
      expect(bodySpy).not.toHaveBeenCalled();
    } finally {
      bodySpy.mockRestore();
      await close();
    }
  });

  // Issue #537 item 4: send >MAX_PRE_VERDICT_FRAMES (100) frames during
  // the pre-verdict window with an ADMIT verdict. Assert (a) the warn
  // line fires exactly once, (b) the connection still completes, (c)
  // dispatch volume is capped at 100 — frames beyond the cap are
  // silently dropped (verified via the warn-fires-once assertion).
  it('drops frames past MAX_PRE_VERDICT_FRAMES with a single warn on admit', async () => {
    rieModule.__resetQueue();

    // Delay the $connect verdict so the client can spam frames.
    let releaseConnect: (() => void) | null = null;
    rieModule.invokeRie.mockImplementationOnce(async () => {
      await new Promise<void>((r) => {
        releaseConnect = r;
      });
      return { payload: { statusCode: 200 }, raw: '{"statusCode":200}' };
    });
    // Queue 100 $default responses for the buffered drain (cap = 100).
    for (let i = 0; i < 100; i += 1) {
      rieModule.__queueInvokeResult({});
    }

    const pool = buildFakePool();
    const api = buildApi([
      { routeKey: '$connect', lambda: 'ConnectFn' },
      { routeKey: '$default', lambda: 'DefaultFn' },
    ]);
    const { port, close } = await startTestServer({
      apis: [{ api, apiPath: '/prod' }],
      pool,
    });
    const warnSpy = vi.spyOn(ConsoleLogger.prototype, 'warn');
    try {
      const ws = await openWebSocket(port, '/prod');
      // Spam 150 frames during the pre-verdict await window.
      for (let i = 0; i < 150; i += 1) {
        ws.send(`frame-${i}`);
      }
      // Wait for the server to receive all 150 frames before releasing
      // the verdict.
      await new Promise((r) => setTimeout(r, 100));
      (releaseConnect as (() => void) | null)?.();
      // Wait for $connect + drain to settle (101 invokeRie calls expected).
      await waitFor(() => rieModule.invokeRie.mock.calls.length >= 101);
      // The cap is enforced: only 100 buffered frames drained, NOT 150.
      // Cap = 100, plus 1 for $connect, total 101.
      expect(rieModule.invokeRie).toHaveBeenCalledTimes(101);
      // The warn line for the buffer-overflow fires exactly once.
      const overflowWarns = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('pre-verdict message buffer overflowed')
      );
      expect(overflowWarns).toHaveLength(1);
      // Item 3 follow-up: the warn line carries the API's declaredAt.
      expect(overflowWarns[0]![0]).toContain('api=S/WsApi');
      ws.close();
      await awaitClose(ws);
    } finally {
      warnSpy.mockRestore();
      await close();
    }
  });

  // Issue #537 item 5: $connect verdict resolves AFTER the client has
  // already disconnected. The post-await `ws.readyState !== OPEN`
  // branch must (a) skip registry insertion, (b) skip $disconnect
  // Lambda dispatch (no listeners were attached pre-await, so 'close'
  // never fired into onDisconnect).
  it('skips registration + $disconnect when client closes during $connect await', async () => {
    rieModule.__resetQueue();
    // Delay the $connect verdict so the client can disconnect first.
    let releaseConnect: (() => void) | null = null;
    rieModule.invokeRie.mockImplementationOnce(async () => {
      await new Promise<void>((r) => {
        releaseConnect = r;
      });
      return { payload: { statusCode: 200 }, raw: '{"statusCode":200}' };
    });

    const pool = buildFakePool();
    const api = buildApi([
      { routeKey: '$connect', lambda: 'ConnectFn' },
      { routeKey: '$disconnect', lambda: 'DisconnectFn' },
    ]);
    const server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const attached = attachWebSocketServer({
      httpServer: server,
      apis: [{ api, apiPath: '/prod' }],
      pool,
      rieTimeoutMs: 2000,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const ws = await openWebSocket(port, '/prod');
      // Client disconnects WHILE the verdict is still pending.
      ws.close(1000, 'client-gone');
      await awaitClose(ws);
      // Wait briefly for the close to flush through the server.
      await new Promise((r) => setTimeout(r, 50));
      // Now release the $connect verdict — the post-await branch
      // should observe readyState !== OPEN and bail.
      (releaseConnect as (() => void) | null)?.();
      // Give the post-await branch a tick to run.
      await new Promise((r) => setTimeout(r, 100));
      // (a) Registry has no entry — the connection was never registered.
      expect(attached.registry.size()).toBe(0);
      // (b) $disconnect Lambda was NEVER invoked: only $connect ran.
      expect(rieModule.invokeRie).toHaveBeenCalledTimes(1);
      const onlyCall = rieModule.invokeRie.mock.calls[0] as any;
      expect(onlyCall[2].requestContext.routeKey).toBe('$connect');
    } finally {
      await attached.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
  });
});

// Issue #527 M1: per-connection message dispatch is SERIALIZED via a
// promise chain. AWS WebSocket APIs invoke handlers serially per
// connection (frame N+1 never starts dispatching until frame N's
// handler returns); without the chain, three rapid frames race the
// warm-pool entry and produce out-of-order handler invocations.
describe('per-connection dispatch serialization (M1)', () => {
  beforeEach(() => {
    rieModule.__resetQueue();
    rieModule.invokeRie.mockClear();
  });
  it('dispatches frames in arrival order for a single connection', async () => {
    rieModule.__resetQueue();
    rieModule.__queueInvokeResult({ statusCode: 200 }); // $connect

    // Each $default invocation records its start order then sleeps a
    // descending amount. If dispatch were parallel, frame 0's 100ms
    // sleep would finish AFTER frames 1 / 2 (50ms / 10ms) — exit
    // order would be reversed. With the chain, exit order matches
    // arrival order regardless of per-call sleep.
    const startOrder: number[] = [];
    const endOrder: number[] = [];
    rieModule.invokeRie.mockImplementationOnce(async () => ({
      payload: { statusCode: 200 },
      raw: '{"statusCode":200}',
    }));
    const sleeps = [100, 50, 10];
    for (let i = 0; i < sleeps.length; i += 1) {
      const ms = sleeps[i]!;
      const idx = i;
      rieModule.invokeRie.mockImplementationOnce(async () => {
        startOrder.push(idx);
        await new Promise((r) => setTimeout(r, ms));
        endOrder.push(idx);
        return { payload: {}, raw: '{}' };
      });
    }

    const pool = buildFakePool();
    const api = buildApi([
      { routeKey: '$connect', lambda: 'ConnectFn' },
      { routeKey: '$default', lambda: 'DefaultFn' },
    ]);
    const { port, close } = await startTestServer({
      apis: [{ api, apiPath: '/prod' }],
      pool,
    });
    try {
      const ws = await openWebSocket(port, '/prod');
      ws.send(JSON.stringify({ action: 'a', seq: 0 }));
      ws.send(JSON.stringify({ action: 'b', seq: 1 }));
      ws.send(JSON.stringify({ action: 'c', seq: 2 }));
      // Wait for all 3 $default handlers to fully complete (NOT just
      // be invoked). With serialization, total wall-clock is
      // ~100+50+10 = 160ms; ceiling 2s leaves room for scheduler jitter.
      await waitFor(() => endOrder.length >= 3, 2000);
      expect(rieModule.invokeRie).toHaveBeenCalledTimes(4);
      // Arrival order is preserved on both start AND end. Pre-fix the
      // parallel dispatch would have endOrder = [2, 1, 0].
      expect(startOrder).toEqual([0, 1, 2]);
      expect(endOrder).toEqual([0, 1, 2]);
      ws.close();
      await awaitClose(ws);
    } finally {
      await close();
    }
  });
});

// Issue #527 M3: graceful shutdown drains in-flight $disconnect
// dispatches with a bounded ceiling. A hung handler pre-fix would leak
// its rieTimeoutMs (60s+) past close()'s 5s socket-close timeout. Note that
// `close()` has TWO 5s timers and they are unrelated: the socket-close
// path's defensive per-socket timeout, and `SHUTDOWN_DRAIN_MS`, the drain
// ceiling this block is about. Everything below turns on the second.
describe('graceful shutdown bounded drain (M3)', () => {
  // The hung `$disconnect` outlasts `SHUTDOWN_DRAIN_MS`, and the per-case
  // timeout outlasts BOTH. That ordering is what lets an assertion do the
  // reporting: a drain that lost its ceiling finishes when this handler
  // does, and is named rather than killed by the runner at a deadline the
  // handler was still racing.
  //
  // The socket-close phase runs BEFORE the drain and carries its own 5s
  // timer, so the effective margin is
  // `HUNG_DISCONNECT_MS - (that phase + SHUTDOWN_DRAIN_MS)` -- about 5s at
  // these values once a slow phase is allowed for, against the 2.5s the
  // removed wall-clock bound had.
  //
  // What it is bought with, scoped to the shape that pays it: a mutant that
  // leaves the drain BLOCKED on the hung handler cannot report until that
  // handler settles, so its failure arrives at roughly `HUNG_DISCONNECT_MS`.
  // Widening this constant delays that one report by the same amount. The
  // other mutants probed against this case fail at their own ceilings
  // instead, and no cost lands on the passing path at all, which never
  // awaits this handler.
  const HUNG_DISCONNECT_MS = 15_000;
  const CASE_TIMEOUT_MS = 25_000;
  // How long the `1/2` case waits for `close()` before reporting that the
  // drain never gave up. Above the 5s ceiling by the same margin
  // `HUNG_DISCONNECT_MS` carries, and below `CASE_TIMEOUT_MS` so the
  // assertion reports rather than the runner.
  const CEILING_REPORT_MS = 15_000;

  beforeEach(() => {
    rieModule.__resetQueue();
    rieModule.invokeRie.mockClear();
  });
  it('logs a warn naming the leaking $disconnect count when drain times out', async () => {
    rieModule.__resetQueue();
    // Flips only when the hung `$disconnect` finally returns — the thing the
    // drain must NOT wait for. `close()` races `Promise.allSettled` of the
    // in-flight handlers against a `SHUTDOWN_DRAIN_MS` timer, so "the drain
    // gave up" IS "that allSettled had not settled", which this observes
    // directly.
    let disconnectSettled = false;
    // $disconnect hangs longer than the 5s drain window.
    rieModule.invokeRie.mockImplementation(async (_id: string, _meta: unknown, event: any) => {
      const routeKey = event?.requestContext?.routeKey;
      if (routeKey === '$connect') return { payload: { statusCode: 200 }, raw: '{}' };
      // Sleep past the drain window — exact value doesn't matter past 5s.
      await new Promise((r) => setTimeout(r, HUNG_DISCONNECT_MS).unref?.());
      disconnectSettled = true;
      return { payload: {}, raw: '{}' };
    });

    const pool = buildFakePool();
    const api = buildApi([
      { routeKey: '$connect', lambda: 'ConnectFn' },
      { routeKey: '$disconnect', lambda: 'DisconnectFn' },
    ]);
    const server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const attached = attachWebSocketServer({
      httpServer: server,
      apis: [{ api, apiPath: '/prod' }],
      pool,
      rieTimeoutMs: 60_000,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const warnSpy = vi.spyOn(ConsoleLogger.prototype, 'warn');
    try {
      const ws = await openWebSocket(port, '/prod');
      await waitFor(() => attached.registry.size() === 1, 1000);
      // `ws.close()` only starts the handshake -- the close frame is an
      // async write, so the server-side listener that dispatches
      // `$disconnect` runs INSIDE `attached.close()`'s socket-close loop,
      // one loopback round-trip later. We do not await ws's close event
      // here because `attached.close()` drives it to completion. The drain
      // then hits the ceiling and the warn fires.
      //
      // Calling `attached.close()` in the SAME tick is load-bearing twice
      // over: `close()` snapshots `wss.clients` synchronously, and calling
      // it synchronously is what GUARANTEES that snapshot is non-empty --
      // sufficient rather than necessary, since an intervening await need
      // not let the socket actually close; and the `$disconnect` promise is added to
      // `inFlightDisconnects` synchronously inside the connection-time
      // `close` listener, which was registered BEFORE `close()`'s own
      // `ws.once('close', ...)`, so registration always wins the race
      // against `Promise.all(closes)` rather than winning it by timing.
      ws.close();
      const t0 = Date.now();
      await attached.close();
      const elapsed = Date.now() - t0;
      // The drain really waited rather than returning at once. Kept as a
      // wall-clock bound because a LOWER one cannot fail from a slow host,
      // only from one running faster than real time.
      //
      // It is also what stops the next assertion passing VACUOUSLY. If no
      // `$disconnect` ever registered, `inFlightDisconnects` would be empty,
      // `close()` would skip the drain block entirely and return in ~5 ms
      // with `disconnectSettled` still false -- which reads identical to a
      // correct give-up. This line is the guard that fails there, so the
      // two are a pair rather than one bound plus a leftover.
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      // ...and it gave up before the handler. This and the `drained for
      // 5000ms` assertion below together replace an `elapsed < 7_500` upper
      // bound that went red twice under a concurrent suite with no defect
      // present (issue #2795): a host stall inflates `elapsed` against a
      // fixed constant, where this compares two timers that a stall delays
      // together. Measured, not assumed to be absolute, across separate
      // runs: the old bound red at 7751 / 7815 ms when the issue was filed,
      // and again at 7907 ms in a run carrying BOTH bounds where the new
      // assertions passed; the fixed case then went 5/5 at load average 35
      // on 16 cores. It is not an INVARIANT -- the two timers are armed at different
      // moments (the handler's when the close listener dispatches
      // `$disconnect`, the drain's after the socket closes settle), so a
      // stall between those two moments does move their deadlines relative
      // to each other. What makes it hold in practice is the margin between
      // the ceiling and the handler, where the removed bound had 2.5s
      // against a fixed constant.
      //
      // This half alone would NOT: it only says the drain quit somewhere
      // short of `HUNG_DISCONNECT_MS`, so a ceiling raised to 8s still
      // passes it -- and the wider that constant is set, the wider this
      // undisclosed window gets, which is the cost side of the sizing above.
      // The removed bound did catch that, which is why the ceiling's VALUE
      // is pinned below rather than left to this.
      //
      // What the trio does NOT recover: `close()` is still bounded, but at
      // the handler's settle point rather than at 7500, so latency added between
      // those two figures is invisible where the removed bound saw it. That
      // is UNRELATED latency -- awaiting `drainComplete` itself is caught
      // (measured), because the mock sets the flag before returning, so it
      // is already true when `allSettled` resolves. A drain scheduling a
      // delay other than the constant it logs is the reachable case. The
      // removed bound did not see all of that class either, only the part
      // pushing the total past its own 7500, so an extra 1s passed it too;
      // what it had was 2.5s of slack where this has the ceiling-to-handler
      // margin. Narrowing
      // that needs a duration bound, the instrument this case drops on
      // purpose, having measured it red twice with nothing wrong. A
      // `setTimeout` spy is not a way back: the socket-close path above
      // schedules its own 5s timer, so the delays are not separable by
      // value, and separating them by count or order would pin the socket
      // loop's shape instead of the drain's.
      // The message says only what the flag OBSERVES. `disconnectSettled`
      // being true means the handler settled before `close()` RETURNED, and
      // `close()` still awaits `wss.close()` after the drain, so a long
      // enough stall there flips it without the drain having waited at all.
      // Blaming the drain in the message would be the same misreporting
      // this case was rewritten to stop doing.
      expect(
        disconnectSettled,
        'the in-flight $disconnect settled before close() returned'
      ).toBe(false);
      const drainWarns = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('graceful shutdown drained for')
      );
      expect(drainWarns).toHaveLength(1);
      // The ceiling CONSTANT, pinned off the message rather than the clock:
      // the warn interpolates `SHUTDOWN_DRAIN_MS`, so moving it to 8s
      // rewrites this string where `disconnectSettled` sees nothing. It pins
      // the constant, NOT the delay actually scheduled -- see the residual
      // noted above.
      expect(drainWarns[0]![0]).toContain('drained for 5000ms');
      // The COUNT this case is named for. It was named and not asserted, so
      // a warn reporting the wrong number of leaked handlers satisfied every
      // other line here. What it pins is the MAGNITUDE and not the two
      // POSITIONS: one connection makes numerator and denominator both 1, so
      // swapping them in the message would still pass. Separating them takes
      // a second connection that is pending AT the snapshot and settles
      // AFTER it -- settling before the snapshot leaves both counts at 1
      // again -- and the release therefore has to be ordered against the
      // snapshot rather than timed near it, which is what this case had no
      // mechanism for. The magnitude check stays here; the `1/2` case below
      // (issue go-to-k/cdkd#2904) carries the positions, on an
      // `allSettled` signal that cannot land early.
      expect(drainWarns[0]![0]).toContain('1/1 $disconnect handlers');
      expect(drainWarns[0]![0]).toContain('still in flight');
    } finally {
      warnSpy.mockRestore();
      rieModule.invokeRie.mockReset();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
  }, CASE_TIMEOUT_MS);

  // ---------------------------------------------------------------------
  // The two gaps issue go-to-k/cdkd#2904 filed against the case above, and
  // the fixture both of them needed: a `$disconnect` that is RELEASED ON A
  // SIGNAL rather than after a sleep.
  //
  // The signal is `Promise.allSettled`. In `websocket-server.ts` it is called
  // exactly once, inside the drain and one line AFTER `drainStartCount` is
  // snapshotted (`Promise.all(closes)` above it is a different method), which
  // is the ORDERING argument: the release below can never land before the
  // snapshot, where a sleep tuned near it could. The case above rejects a
  // `setTimeout` spy for the same job because the socket-close loop schedules
  // a 5s timer of its own and the two are not separable by value;
  // `allSettled` has no such twin.
  //
  // That file-scoped count is NOT what makes the signal trustworthy, and
  // saying so would be describing a mechanism this case does not stand on:
  // the spy replaces the GLOBAL `Promise.allSettled`, so any other caller
  // reaching it inside the spy window would resolve `started` first, with a
  // foreign array. Two things close that, and both are deliberate — the spy
  // is installed immediately before `attached.close()` and removed in
  // `finally`, so the window is that one call; and `drain.calls()` is
  // asserted to be exactly 1, which a foreign call turns into 2. The
  // assertion is doing that job as much as the drain-skip one.
  //
  // It doubles as the vacuity guard the issue's plan asks for: if a case
  // never registered a `$disconnect`, `close()` takes the `size > 0` early
  // skip and the spy never fires. Both cases therefore RACE the signal
  // against `close()` returning and assert which won, so that path reports
  // itself in milliseconds by name -- a bare await would hang on a promise
  // that never settles and be killed at `CASE_TIMEOUT_MS` naming nothing.
  const gatedDisconnect = (): { opened: Promise<void>; release: () => void } => {
    let release!: () => void;
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { opened, release };
  };

  /**
   * Spy on the drain's own `allSettled`, returning both the promise that
   * settles when the drain starts and the recorded argument — the array the
   * count is taken from, which `gap 1` asserts on directly.
   */
  const watchDrainStart = (): {
    started: Promise<unknown[]>;
    restore: () => void;
    calls: () => number;
  } => {
    const real = Promise.allSettled.bind(Promise);
    let seen = 0;
    let resolveStarted!: (items: unknown[]) => void;
    const started = new Promise<unknown[]>((resolve) => {
      resolveStarted = resolve;
    });
    const spy = vi
      .spyOn(Promise, 'allSettled')
      .mockImplementation(((items: Iterable<unknown>) => {
        const arr = Array.from(items);
        seen += 1;
        resolveStarted(arr);
        return real(arr as never);
      }) as typeof Promise.allSettled);
    return { started, restore: () => spy.mockRestore(), calls: () => seen };
  };

  /**
   * Whether the drain's CEILING actually fired, observed rather than timed.
   * Wraps every `setTimeout` armed at `SHUTDOWN_DRAIN_MS` and counts the
   * callbacks that RUN, so "close() returned through completion" becomes an
   * ORDERING fact — the ceiling had not fired yet — instead of an elapsed
   * measurement. An elapsed bound cannot do this job: the production timer is
   * armed several microtasks BEFORE any clock the test can read, so a stall in
   * between spends the ceiling without the test seeing it, and the
   * completion-arm mutant passes an elapsed bound (measured by review).
   *
   * The socket-close loop above arms 5s timers too, and production never
   * clears them — they fire ~5s after arming whether or not their socket
   * closed, so this counter cannot tell them from the ceiling. What makes the
   * count meaningful is WHEN it is read: at the moment `close()` returns. On
   * the completion path that is milliseconds in, before any 5s timer has run,
   * so the count is 0; on the mutant path the ceiling IS one of those
   * callbacks and `close()` cannot return until it has run, so the count is
   * non-zero (measured: 2, the ceiling plus the socket-close timer armed
   * beside it). The residual is a case stalled past 5s before `close()`
   * returns, where a socket timer would be counted — a false RED, never a
   * pass.
   */
  const watchCeilingFire = (): { fired: () => number; restore: () => void } => {
    const real = globalThis.setTimeout;
    let fired = 0;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      const wrapped =
        ms === 5_000
          ? (...args: unknown[]): void => {
              fired += 1;
              fn(...args);
            }
          : fn;
      return (real as unknown as (...a: unknown[]) => ReturnType<typeof setTimeout>)(
        wrapped,
        ms,
        ...rest
      );
    }) as unknown as typeof globalThis.setTimeout);
    return { fired: () => fired, restore: () => spy.mockRestore() };
  };

  it('returns through the drain COMPLETION arm when the $disconnect settles', async () => {
    rieModule.__resetQueue();
    const gate = gatedDisconnect();
    let disconnectSettled = false;
    rieModule.invokeRie.mockImplementation(async (_id: string, _meta: unknown, event: any) => {
      const routeKey = event?.requestContext?.routeKey;
      if (routeKey === '$connect') return { payload: { statusCode: 200 }, raw: '{}' };
      await gate.opened;
      disconnectSettled = true;
      return { payload: {}, raw: '{}' };
    });

    const pool = buildFakePool();
    const api = buildApi([
      { routeKey: '$connect', lambda: 'ConnectFn' },
      { routeKey: '$disconnect', lambda: 'DisconnectFn' },
    ]);
    const server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const attached = attachWebSocketServer({
      httpServer: server,
      apis: [{ api, apiPath: '/prod' }],
      pool,
      rieTimeoutMs: 60_000,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const warnSpy = vi.spyOn(ConsoleLogger.prototype, 'warn');
    // Assigned inside the `try` rather than here: both patch GLOBALS, so a
    // throw between two bare installs would leave one of them in place for
    // the rest of the file (`vite.config.ts` sets neither `restoreMocks` nor
    // `clearMocks`, so nothing else puts it back). Installed as late as
    // possible for the same reason — the narrower the window, the less any
    // other caller can be mistaken for the drain.
    let drain: ReturnType<typeof watchDrainStart> | undefined;
    let ceiling: ReturnType<typeof watchCeilingFire> | undefined;
    try {
      const ws = await openWebSocket(port, '/prod');
      await waitFor(() => attached.registry.size() === 1, 1000);
      ws.close();
      // Same tick as `ws.close()` and as the spy installs: `close()` snapshots
      // `wss.clients` synchronously, and NOT awaited here because the drain
      // has to be running for the release below to mean anything.
      drain = watchDrainStart();
      ceiling = watchCeilingFire();
      const closing = attached.close();
      // Raced against `close()` RETURNING, not awaited bare: if the drain is
      // skipped — the `size > 0` early exit, which a case that registered no
      // `$disconnect` takes — `drain.started` never settles and a bare await
      // hangs until the runner kills the case at `CASE_TIMEOUT_MS` with a
      // deadline message that names nothing. Racing makes that path report
      // itself, in milliseconds, in this assertion (measured: the mutant
      // `if (false)` reds here rather than timing out).
      const reached = await Promise.race([
        drain.started.then(() => 'drain' as const),
        closing.then(() => 'closed' as const),
      ]);
      expect(reached, 'close() returned without entering the drain').toBe('drain');
      gate.release();
      await closing;

      // TWO jobs, both load-bearing: `close()` reached the drain rather than
      // taking the `size > 0` skip, AND nothing but the drain called
      // `allSettled` inside the window — a foreign call would have resolved
      // `started` above and would show up here as 2.
      expect(drain.calls(), 'exactly one allSettled — the drain\'s').toBe(1);
      expect(disconnectSettled, 'the $disconnect ran to completion').toBe(true);
      // THE discriminator, and an ORDERING one. Dropping
      // `drainComplete.then(...)` from the race leaves only the ceiling, so
      // `close()` can return no earlier than that timer's callback — and it
      // returns SILENTLY, since the warn also needs handlers still in flight
      // and this one finished. "No warn" alone therefore cannot kill that
      // mutant, which is why this line exists.
      //
      // Deliberately NOT an elapsed bound. The ceiling is armed inside
      // `close()` several microtasks before any clock this case can read, so
      // a pause in between spends part of it uncounted and the mutant slips
      // under a `< 5000` comparison (measured during review: a 4.5s pause let
      // an await-the-ceiling-only path report 501ms). Counting the fired
      // callback asks the question directly instead.
      expect(ceiling.fired(), 'close() returned before the drain ceiling fired').toBe(0);
      const drainWarns = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('graceful shutdown drained for')
      );
      expect(drainWarns).toHaveLength(0);
    } finally {
      ceiling?.restore();
      drain?.restore();
      warnSpy.mockRestore();
      rieModule.invokeRie.mockReset();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
  }, CASE_TIMEOUT_MS);

  it('names the leaked count and the snapshot SEPARATELY: 1 of 2 still in flight', async () => {
    rieModule.__resetQueue();
    // Two connections, both pending when the count is snapshotted; one is
    // released after the snapshot and one is never released, so numerator
    // and denominator differ and the message's two positions are separable.
    // The releasable one is chosen by ORDER of dispatch, which is all the
    // handler can see.
    const gates = [gatedDisconnect(), gatedDisconnect()];
    let dispatched = 0;
    rieModule.invokeRie.mockImplementation(async (_id: string, _meta: unknown, event: any) => {
      const routeKey = event?.requestContext?.routeKey;
      if (routeKey === '$connect') return { payload: { statusCode: 200 }, raw: '{}' };
      const gate = gates[dispatched] ?? gates[gates.length - 1]!;
      dispatched += 1;
      await gate.opened;
      return { payload: {}, raw: '{}' };
    });

    const pool = buildFakePool();
    const api = buildApi([
      { routeKey: '$connect', lambda: 'ConnectFn' },
      { routeKey: '$disconnect', lambda: 'DisconnectFn' },
    ]);
    const server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const attached = attachWebSocketServer({
      httpServer: server,
      apis: [{ api, apiPath: '/prod' }],
      pool,
      rieTimeoutMs: 60_000,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const warnSpy = vi.spyOn(ConsoleLogger.prototype, 'warn');
    // Installed inside the `try`, immediately before `close()` — see the
    // completion case for why the window is kept that narrow and why a bare
    // install outside the `try` can leak a global patch into the rest of the
    // file.
    let drain: ReturnType<typeof watchDrainStart> | undefined;
    let hungTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const first = await openWebSocket(port, '/prod');
      const second = await openWebSocket(port, '/prod');
      await waitFor(() => attached.registry.size() === 2, 1000);
      first.close();
      second.close();
      drain = watchDrainStart();
      const closing = attached.close();
      // Raced against `close()` returning for the reason the case above
      // spells out: a skipped drain never settles `drain.started`, and a
      // bare await would hand that to the runner as a deadline instead of an
      // assertion.
      const reached = await Promise.race([
        drain.started.then((items) => ({ kind: 'drain' as const, items })),
        closing.then(() => ({ kind: 'closed' as const, items: [] as unknown[] })),
      ]);
      expect(reached.kind, 'close() returned without entering the drain').toBe('drain');
      // The count's INPUT, asserted before the message that reports it: two
      // handlers were in flight at the snapshot. Without this the `1/2`
      // below could be reached by a one-connection race that happened to
      // register twice.
      expect(reached.items).toHaveLength(2);
      // Released AFTER the snapshot, which is the ordering `allSettled`
      // buys: one settles inside the window, the other never does.
      gates[0]!.release();
      // Bounded for the same reason the case above races: the second handler
      // is never released, so a drain that LOST its ceiling waits on it
      // forever and `await closing` would be killed by the runner instead of
      // reporting. The correct path returns at the 5s ceiling, so this bound
      // carries 10s of margin, and a stall long enough to overrun it fails
      // RED rather than passing something broken. `CASE_TIMEOUT_MS` stays
      // above it so this assertion is always the one that speaks.
      const returned = await Promise.race([
        closing.then(() => 'closed' as const),
        new Promise<'hung'>((resolve) => {
          // Handle kept so the winner can clear it: unref'd is enough to let
          // the process exit, but a 15s timer left armed after this case has
          // returned is still a timer the next case runs alongside.
          hungTimer = setTimeout(() => resolve('hung'), CEILING_REPORT_MS);
          hungTimer.unref?.();
        }),
      ]);
      expect(returned, 'close() never returned — the drain waited past its ceiling').toBe('closed');

      // Both jobs again: the drain was reached, and no foreign `allSettled`
      // resolved `started` inside the window.
      expect(drain.calls(), 'exactly one allSettled — the drain\'s').toBe(1);
      const drainWarns = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('graceful shutdown drained for')
      );
      expect(drainWarns).toHaveLength(1);
      // Both POSITIONS, which one connection cannot separate: swapping the
      // two interpolations gives `2/1` here and hard-coding `1/1` gives
      // `1/1`, where the case above passes under either.
      expect(drainWarns[0]![0]).toContain('1/2 $disconnect handlers');
    } finally {
      // The never-released handler is what makes the drain time out, and it
      // would otherwise pend for the rest of the run: `inFlightDisconnects`
      // holds it, and the dispatch chain's own `.finally` cleanup cannot run
      // until it settles. Releasing here drains both — the assertions above
      // are already done, so it changes nothing they saw.
      gates[1]!.release();
      if (hungTimer !== undefined) clearTimeout(hungTimer);
      drain?.restore();
      warnSpy.mockRestore();
      rieModule.invokeRie.mockReset();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
  }, CASE_TIMEOUT_MS);
});
