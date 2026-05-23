/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import {
  attachWebSocketServer,
  bufferToBody,
  type AttachOptions,
} from '../../../src/local/websocket-server.js';
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

// B3 (#526): bufferToBody returns the discriminated `{body, isBase64Encoded}`
// shape so binary frames surface as base64 + the flag, and text frames
// surface as UTF-8 + flag=false. Pre-fix the function returned a bare
// string and the discriminator was hardcoded `false` downstream.
describe('bufferToBody (B3 regression guard)', () => {
  beforeEach(() => {
    rieModule.__resetQueue();
    rieModule.invokeRie.mockClear();
  });
  it('returns text body + isBase64Encoded=false for text frames', () => {
    const buf = Buffer.from('hello world', 'utf-8');
    expect(bufferToBody(buf, false)).toEqual({
      body: 'hello world',
      isBase64Encoded: false,
    });
  });

  it('returns base64 body + isBase64Encoded=true for binary frames', () => {
    const buf = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80]);
    expect(bufferToBody(buf, true)).toEqual({
      body: buf.toString('base64'),
      isBase64Encoded: true,
    });
  });

  it('preserves bytes > 0x7F across binary round-trip (the original bug class)', () => {
    // 0xFE / 0xFF are NOT valid UTF-8; pre-fix decoding them as UTF-8
    // would surface as U+FFFD (replacement char), corrupting the
    // handler's `Buffer.from(event.body, 'utf8')` decode.
    const original = Buffer.from([0xff, 0xfe, 0x80, 0x7f, 0x00]);
    const { body, isBase64Encoded } = bufferToBody(original, true);
    expect(isBase64Encoded).toBe(true);
    const roundTrip = Buffer.from(body, 'base64');
    expect(roundTrip.equals(original)).toBe(true);
  });

  it('concatenates fragmented Buffer[] input before encoding', () => {
    const fragments = [Buffer.from([0x01, 0x02]), Buffer.from([0x03, 0x04])];
    const { body, isBase64Encoded } = bufferToBody(fragments, true);
    expect(isBase64Encoded).toBe(true);
    expect(Buffer.from(body, 'base64')).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04]));
  });

  it('handles ArrayBuffer input', () => {
    const ab = new ArrayBuffer(3);
    new Uint8Array(ab).set([0x41, 0x42, 0x43]); // "ABC"
    expect(bufferToBody(ab, false)).toEqual({
      body: 'ABC',
      isBase64Encoded: false,
    });
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
      await new Promise((r) => setTimeout(r, 100));
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
      await new Promise((r) => setTimeout(r, 100));
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
    } finally {
      await close();
    }
  });
});
