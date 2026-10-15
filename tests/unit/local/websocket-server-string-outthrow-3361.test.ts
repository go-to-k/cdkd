import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/local/websocket-server.ts` slice: the dispatch handlers stringified
 * their caught value with a bare `String()` arm, and
 * `String(Object.create(null))` throws
 * `TypeError: Cannot convert object to primitive value` -- so the handler threw
 * from inside itself. A dispatch `.catch` that throws rejects the
 * per-connection chain, and every later frame (and the `$disconnect`) chained
 * behind it is skipped.
 *
 * Each case rejects with exactly that value and asserts the DEGRADATION still
 * happens (the 1011 close, the error frame, the next frame dispatched), never
 * merely "it did not throw". The placeholder is asserted too, so a fix that
 * swallowed the failure without reporting it would not pass.
 */

vi.mock('../../../src/local/rie-client.js', () => ({
  invokeRie: vi.fn(async () => ({ payload: { statusCode: 200 }, raw: '{"statusCode":200}' })),
  waitForRieReady: vi.fn(async () => undefined),
}));

import { invokeRie } from '../../../src/local/rie-client.js';
import { attachWebSocketServer } from '../../../src/local/websocket-server.js';
import * as websocketBody from '../../../src/local/websocket-body.js';
import { ConsoleLogger } from '../../../src/utils/logger.js';
import type { ContainerHandle, ContainerPool } from '../../../src/local/container-pool.js';
import type { DiscoveredWebSocketApi } from '../../../src/local/websocket-route-discovery.js';

/** What `safeStringify` / `describeAwsFailure(x).detail` render for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

/** A rejection whose `String()` throws. */
const unconvertible = (): unknown => Object.create(null) as unknown;

const invokeRieMock = vi.mocked(invokeRie);

/** A pool whose first `acquire` of `failOnce` rejects with an unconvertible value. */
function poolFailingOnce(failOnce: string | undefined): ContainerPool {
  let failed = false;
  return {
    acquire: vi.fn(async (logicalId: string): Promise<ContainerHandle> => {
      if (logicalId === failOnce && !failed) {
        failed = true;
        throw unconvertible();
      }
      return {
        logicalId,
        containerId: `cid-${logicalId}`,
        containerName: `name-${logicalId}`,
        hostPort: 9999,
        containerHost: '127.0.0.1',
        stopLogStream: () => undefined,
      };
    }),
    release: vi.fn(),
    dispose: vi.fn(async () => undefined),
  };
}

function buildApi(routeKeys: string[]): DiscoveredWebSocketApi {
  return {
    apiLogicalId: 'WsApi',
    apiStackName: 'S',
    declaredAt: 'S/WsApi',
    routeSelectionExpression: '$request.body.action',
    stage: 'prod',
    routes: routeKeys.map((routeKey) => ({
      routeKey,
      targetLambdaLogicalId: `${routeKey.replace('$', '')}Fn`,
      lambdaStackName: 'S',
      declaredAt: `S/RouteFor${routeKey}`,
    })),
  };
}

async function startServer(
  pool: ContainerPool,
  routeKeys: string[]
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const attached = attachWebSocketServer({
    httpServer: server,
    apis: [{ api: buildApi(routeKeys), apiPath: '/prod' }],
    pool,
    rieTimeoutMs: 2000,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      await attached.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

function openWebSocket(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/prod`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Hold the `$connect` verdict until the returned release is called. */
function holdConnectVerdict(): () => void {
  let release!: () => void;
  invokeRieMock.mockImplementationOnce(async () => {
    await new Promise<void>((r) => {
      release = r;
    });
    return { payload: { statusCode: 200 }, raw: '{"statusCode":200}' } as never;
  });
  return () => release();
}

/** Whether `invokeRie` was called for a route with this key. */
const dispatchedRouteKeys = (): string[] =>
  invokeRieMock.mock.calls.map(
    (c) => (c[2] as { requestContext: { routeKey: string } }).requestContext.routeKey
  );

describe('WebSocket dispatch with an unconvertible failure (#3361)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const logged = (spy: ReturnType<typeof vi.spyOn>): string[] =>
    spy.mock.calls.map((c: unknown[]) => String(c[0]));

  beforeEach(() => {
    // `mockReset`, not `mockClear`: a hold left queued by a failed case must not
    // leak into the next one.
    invokeRieMock.mockReset();
    invokeRieMock.mockImplementation(
      async () => ({ payload: { statusCode: 200 }, raw: '{"statusCode":200}' }) as never
    );
    errorSpy = vi.spyOn(ConsoleLogger.prototype, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(ConsoleLogger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('still closes the socket with 1011 when $connect fails with one', async () => {
    const { port, close } = await startServer(poolFailingOnce(undefined), ['$connect', '$default']);
    const releaseConnect = holdConnectVerdict();
    // The first frame drained after the verdict throws inside `onConnect`.
    vi.spyOn(websocketBody, 'bufferToBody').mockImplementationOnce(() => {
      throw unconvertible();
    });
    try {
      const ws = await openWebSocket(port);
      const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
      ws.send('{"action":"x"}');
      await vi.waitFor(() => expect(invokeRieMock).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 50));
      releaseConnect();

      expect(await closed).toBe(1011);
      expect(logged(errorSpy)).toContainEqual(
        expect.stringContaining(`WebSocket $connect dispatch failed: ${PLACEHOLDER}`)
      );
    } finally {
      await close();
    }
  });

  it('sends the error frame and keeps dispatching when a message fails with one', async () => {
    const { port, close } = await startServer(poolFailingOnce('defaultFn'), ['$default']);
    try {
      const ws = await openWebSocket(port);
      const frames: string[] = [];
      ws.on('message', (m) => frames.push(m.toString('utf-8')));

      ws.send('{"action":"first"}');
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      ws.send('{"action":"second"}');
      await vi.waitFor(() => expect(dispatchedRouteKeys()).toEqual(['$default']));

      expect(JSON.parse(frames[0]!).message).toBe('Internal server error');
      expect(logged(errorSpy)).toContainEqual(
        expect.stringContaining(`WebSocket message dispatch failed (connection `)
      );
      expect(logged(errorSpy).some((m) => m.endsWith(`): ${PLACEHOLDER}`))).toBe(true);
      ws.close();
    } finally {
      await close();
    }
  });

  it('reports a $disconnect that fails with one', async () => {
    const { port, close } = await startServer(poolFailingOnce('disconnectFn'), ['$disconnect']);
    try {
      const ws = await openWebSocket(port);
      ws.close(1000, 'bye');
      await vi.waitFor(() =>
        expect(logged(warnSpy)).toContainEqual(
          expect.stringContaining('WebSocket $disconnect dispatch failed (connection ')
        )
      );
      expect(logged(warnSpy).some((m) => m.endsWith(`): ${PLACEHOLDER}`))).toBe(true);
    } finally {
      await close();
    }
  });

  it('keeps dispatching after a buffered frame fails with one', async () => {
    const { port, close } = await startServer(poolFailingOnce('defaultFn'), [
      '$connect',
      '$default',
    ]);
    const releaseConnect = holdConnectVerdict();
    try {
      const ws = await openWebSocket(port);
      ws.send('{"action":"buffered"}');
      await vi.waitFor(() => expect(invokeRieMock).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 50));
      releaseConnect();
      await vi.waitFor(() =>
        expect(logged(errorSpy)).toContainEqual(
          expect.stringContaining('WebSocket buffered-message dispatch failed (connection ')
        )
      );

      ws.send('{"action":"live"}');
      await vi.waitFor(() => expect(dispatchedRouteKeys()).toEqual(['$connect', '$default']));
      expect(logged(errorSpy).some((m) => m.endsWith(`): ${PLACEHOLDER}`))).toBe(true);
      ws.close();
    } finally {
      await close();
    }
  });
});
