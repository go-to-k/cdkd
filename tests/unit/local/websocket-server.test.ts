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
// its rieTimeoutMs (60s+) past close()'s 5s socket-close timeout.
describe('graceful shutdown bounded drain (M3)', () => {
  beforeEach(() => {
    rieModule.__resetQueue();
    rieModule.invokeRie.mockClear();
  });
  it('logs a warn naming the leaking $disconnect count when drain times out', async () => {
    rieModule.__resetQueue();
    rieModule.__queueInvokeResult({ statusCode: 200 }); // $connect for the live conn
    // $disconnect hangs longer than the 5s drain window.
    rieModule.invokeRie.mockImplementation(async (_id: string, _meta: unknown, event: any) => {
      const routeKey = event?.requestContext?.routeKey;
      if (routeKey === '$connect') return { payload: { statusCode: 200 }, raw: '{}' };
      // Sleep past the drain window — exact value doesn't matter past 5s.
      await new Promise((r) => setTimeout(r, 10_000).unref?.());
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
      // Closing the WebSocket fires the close listener, which kicks off
      // $disconnect. Then immediately call attached.close() which awaits
      // the drain. The drain hits the 5s ceiling and the warn fires.
      // We do NOT await ws's close event here because attached.close
      // itself drives the close to completion.
      ws.close();
      const t0 = Date.now();
      await attached.close();
      const elapsed = Date.now() - t0;
      // Drain ceiling = 5000ms; some scheduler jitter accepted.
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(7_500);
      const drainWarns = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('graceful shutdown drained for')
      );
      expect(drainWarns).toHaveLength(1);
      expect(drainWarns[0]![0]).toContain('still in flight');
    } finally {
      warnSpy.mockRestore();
      rieModule.invokeRie.mockReset();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
  }, 10_000);
});
