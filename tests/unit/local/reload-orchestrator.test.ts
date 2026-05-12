import { describe, expect, it, vi } from 'vite-plus/test';
import {
  createReloadOrchestrator,
  type NextStateMaterial,
} from '../../../src/local/reload-orchestrator.js';
import type {
  ContainerHandle,
  ContainerPool,
  ContainerSpec,
} from '../../../src/local/container-pool.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';
import type { RouteWithAuth } from '../../../src/local/authorizer-resolver.js';
import type { ServerState } from '../../../src/local/http-server.js';

/** Build a fake ContainerPool that records dispose calls. */
function fakePool(specs: Map<string, ContainerSpec>): ContainerPool & { disposed: boolean } {
  const pool = {
    disposed: false,
    acquire: vi.fn<[string], Promise<ContainerHandle>>(),
    release: vi.fn(),
    dispose: vi.fn(async () => {
      (pool as { disposed: boolean }).disposed = true;
    }),
  } as unknown as ContainerPool & { disposed: boolean };
  Object.defineProperty(pool, '__cdkdSpecs', {
    value: specs,
    enumerable: false,
    configurable: true,
  });
  return pool;
}

/** Build a fake ContainerSpec keyed by logical id. */
function fakeSpec(logicalId: string, overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    lambda: {
      kind: 'zip',
      stack: {} as never,
      logicalId,
      resource: {} as never,
      runtime: 'nodejs20.x',
      handler: 'index.handler',
      memoryMb: 128,
      timeoutSec: 3,
      codePath: '/tmp/code',
    } as ContainerSpec['lambda'],
    codeDir: '/tmp/code',
    env: {},
    containerHost: '127.0.0.1',
    ...overrides,
  };
}

function fakeRoute(over: Partial<DiscoveredRoute> = {}): DiscoveredRoute {
  return {
    method: 'GET',
    pathPattern: '/x',
    lambdaLogicalId: 'L',
    source: 'http-api',
    apiVersion: 'v2',
    stage: '$default',
    declaredAt: 'S/R',
    ...over,
  };
}

/**
 * Wrap a {@link DiscoveredRoute} as a {@link RouteWithAuth} with no
 * authorizer attached. The reload-orchestrator consumes
 * `RouteWithAuth[]` (PR 8b moved authorizer info onto every route)
 * and the tests construct fake routes via {@link fakeRoute}, so this
 * helper converts at the boundary.
 */
function withAuth(route: DiscoveredRoute): RouteWithAuth {
  return { route };
}

describe('createReloadOrchestrator', () => {
  it('atomically swaps server state on a successful reload', async () => {
    const oldSpecs = new Map([['L', fakeSpec('L')]]);
    const oldPool = fakePool(oldSpecs);
    const newSpecs = new Map([['L2', fakeSpec('L2')]]);
    const newPool = fakePool(newSpecs);
    const initialState: ServerState = {
      routes: [withAuth(fakeRoute({ lambdaLogicalId: 'L' }))],
      pool: oldPool,
      corsConfigByApiId: new Map(),
    };
    let currentState: ServerState = initialState;
    const orchestrator = createReloadOrchestrator({
      synthesizeAndBuild: async (): Promise<NextStateMaterial> => ({
        routes: [withAuth(fakeRoute({ lambdaLogicalId: 'L2', pathPattern: '/y' }))],
        specs: newSpecs,
        corsConfigByApiId: new Map(),
      }),
      buildPool: () => newPool,
      setServerState: (next) => {
        const prev = currentState;
        currentState = next;
        return prev;
      },
      getServerState: () => currentState,
    });
    const result = await orchestrator.reload();
    expect(result.ok).toBe(true);
    expect(result.added.map((r) => r.route.lambdaLogicalId)).toEqual(['L2']);
    expect(result.removed.map((r) => r.route.lambdaLogicalId)).toEqual(['L']);
    // New state was swapped in.
    expect(currentState.pool).toBe(newPool);
    // Old pool was disposed (orchestrator runs it in background; await
    // the actual dispose Promise so we don't depend on event-loop
    // scheduling — the pool's `disposed` flag flips synchronously
    // inside the fakePool's `dispose` mock, but the orchestrator
    // fires-and-forgets without awaiting so we wait for the mock to
    // have been called at all).
    await vi.waitUntil(() => oldPool.disposed === true, { timeout: 1_000, interval: 5 });
    expect(oldPool.disposed).toBe(true);
  });

  it('keeps previous state when synthesizeAndBuild rejects', async () => {
    const oldSpecs = new Map([['L', fakeSpec('L')]]);
    const oldPool = fakePool(oldSpecs);
    const initialState: ServerState = {
      routes: [withAuth(fakeRoute({ lambdaLogicalId: 'L' }))],
      pool: oldPool,
      corsConfigByApiId: new Map(),
    };
    let currentState: ServerState = initialState;
    const orchestrator = createReloadOrchestrator({
      synthesizeAndBuild: async (): Promise<NextStateMaterial> => {
        throw new Error('synth blew up');
      },
      buildPool: () => fakePool(new Map()),
      setServerState: (next) => {
        const prev = currentState;
        currentState = next;
        return prev;
      },
      getServerState: () => currentState,
    });
    const result = await orchestrator.reload();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('synth blew up');
    // State unchanged.
    expect(currentState.pool).toBe(oldPool);
    expect(oldPool.disposed).toBe(false);
  });

  it('marks Lambdas with changed specs as rebuilt', async () => {
    const oldSpec = fakeSpec('L', { codeDir: '/tmp/old' });
    const newSpec = fakeSpec('L', { codeDir: '/tmp/new' });
    const oldPool = fakePool(new Map([['L', oldSpec]]));
    const newPool = fakePool(new Map([['L', newSpec]]));
    let currentState: ServerState = {
      routes: [withAuth(fakeRoute({ lambdaLogicalId: 'L' }))],
      pool: oldPool,
      corsConfigByApiId: new Map(),
    };
    const orchestrator = createReloadOrchestrator({
      synthesizeAndBuild: async () => ({
        routes: [withAuth(fakeRoute({ lambdaLogicalId: 'L' }))],
        specs: new Map([['L', newSpec]]),
        corsConfigByApiId: new Map(),
      }),
      buildPool: () => newPool,
      setServerState: (next) => {
        const prev = currentState;
        currentState = next;
        return prev;
      },
      getServerState: () => currentState,
    });
    const result = await orchestrator.reload();
    expect(result.ok).toBe(true);
    expect(result.rebuiltLambdas).toEqual(['L']);
  });

  it('serializes concurrent reload calls', async () => {
    const states: number[] = [];
    let currentState: ServerState = {
      routes: [],
      pool: fakePool(new Map()),
      corsConfigByApiId: new Map(),
    };
    let counter = 0;
    const orchestrator = createReloadOrchestrator({
      synthesizeAndBuild: async () => {
        // Yield to event loop so a second reload can interleave if
        // serialization is broken.
        await new Promise((r) => setImmediate(r));
        states.push(++counter);
        return { routes: [], specs: new Map(), corsConfigByApiId: new Map() };
      },
      buildPool: () => fakePool(new Map()),
      setServerState: (next) => {
        const prev = currentState;
        currentState = next;
        return prev;
      },
      getServerState: () => currentState,
    });
    await Promise.all([orchestrator.reload(), orchestrator.reload(), orchestrator.reload()]);
    // Each reload's body ran in sequence (no interleaved increments).
    expect(states).toEqual([1, 2, 3]);
  });

  it("uses the just-swapped state as the second reload's baseline", async () => {
    // Verifies the diff for reload #2 sees reload #1's NEW state, not
    // the original initial state. Without serialization + atomic swap,
    // a back-to-back add-then-remove sequence would mis-classify both.
    const oldSpecs = new Map([['L', fakeSpec('L')]]);
    const oldPool = fakePool(oldSpecs);
    const stateAfterFirstReloadSpecs = new Map([['L', fakeSpec('L')], ['L2', fakeSpec('L2')]]);
    const stateAfterSecondReloadSpecs = new Map([['L', fakeSpec('L')]]); // back to baseline
    let currentState: ServerState = {
      routes: [withAuth(fakeRoute({ lambdaLogicalId: 'L' }))],
      pool: oldPool,
      corsConfigByApiId: new Map(),
    };
    let synthCallCount = 0;
    const orchestrator = createReloadOrchestrator({
      synthesizeAndBuild: async () => {
        synthCallCount++;
        if (synthCallCount === 1) {
          return {
            routes: [
              withAuth(fakeRoute({ lambdaLogicalId: 'L' })),
              withAuth(fakeRoute({ lambdaLogicalId: 'L2', pathPattern: '/y' })),
            ],
            specs: stateAfterFirstReloadSpecs,
            corsConfigByApiId: new Map(),
          };
        }
        return {
          routes: [withAuth(fakeRoute({ lambdaLogicalId: 'L' }))], // L2 removed
          specs: stateAfterSecondReloadSpecs,
          corsConfigByApiId: new Map(),
        };
      },
      buildPool: () => fakePool(synthCallCount === 1 ? stateAfterFirstReloadSpecs : stateAfterSecondReloadSpecs),
      setServerState: (next) => {
        const prev = currentState;
        currentState = next;
        return prev;
      },
      getServerState: () => currentState,
    });
    const r1 = await orchestrator.reload();
    expect(r1.added.map((r) => r.route.lambdaLogicalId)).toEqual(['L2']);
    expect(r1.removed).toEqual([]);
    const r2 = await orchestrator.reload();
    // Reload 2's BASELINE is reload 1's new state (which has L + L2).
    // So reload 2 sees L2 removed (NOT added — would be the bug).
    expect(r2.added).toEqual([]);
    expect(r2.removed.map((r) => r.route.lambdaLogicalId)).toEqual(['L2']);
  });

  it('handles route-added with no removals', async () => {
    const oldSpecs = new Map([['L', fakeSpec('L')]]);
    const oldPool = fakePool(oldSpecs);
    const newSpecs = new Map([['L', fakeSpec('L')], ['L2', fakeSpec('L2')]]);
    const newPool = fakePool(newSpecs);
    let currentState: ServerState = {
      routes: [withAuth(fakeRoute({ lambdaLogicalId: 'L' }))],
      pool: oldPool,
      corsConfigByApiId: new Map(),
    };
    const orchestrator = createReloadOrchestrator({
      synthesizeAndBuild: async () => ({
        routes: [
          withAuth(fakeRoute({ lambdaLogicalId: 'L' })),
          withAuth(fakeRoute({ lambdaLogicalId: 'L2', pathPattern: '/y' })),
        ],
        specs: newSpecs,
        corsConfigByApiId: new Map(),
      }),
      buildPool: () => newPool,
      setServerState: (next) => {
        const prev = currentState;
        currentState = next;
        return prev;
      },
      getServerState: () => currentState,
    });
    const r = await orchestrator.reload();
    expect(r.ok).toBe(true);
    expect(r.added.map((x) => x.route.lambdaLogicalId)).toEqual(['L2']);
    expect(r.removed).toEqual([]);
    expect(r.rebuiltLambdas).toEqual([]);
  });

  it('treats same-route-different-lambdaLogicalId as add+remove', async () => {
    // The route's path/method tuple stays the same, but the Lambda
    // backing it changed (e.g. user re-pointed an HTTP API route at a
    // different function). Diff key includes lambdaLogicalId so this
    // shows as one removed + one added.
    const oldSpecs = new Map([['LambdaA', fakeSpec('LambdaA')]]);
    const oldPool = fakePool(oldSpecs);
    const newSpecs = new Map([['LambdaB', fakeSpec('LambdaB')]]);
    const newPool = fakePool(newSpecs);
    let currentState: ServerState = {
      routes: [withAuth(fakeRoute({ lambdaLogicalId: 'LambdaA', pathPattern: '/x' }))],
      pool: oldPool,
      corsConfigByApiId: new Map(),
    };
    const orchestrator = createReloadOrchestrator({
      synthesizeAndBuild: async () => ({
        routes: [withAuth(fakeRoute({ lambdaLogicalId: 'LambdaB', pathPattern: '/x' }))],
        specs: newSpecs,
        corsConfigByApiId: new Map(),
      }),
      buildPool: () => newPool,
      setServerState: (next) => {
        const prev = currentState;
        currentState = next;
        return prev;
      },
      getServerState: () => currentState,
    });
    const r = await orchestrator.reload();
    expect(r.added.map((x) => x.route.lambdaLogicalId)).toEqual(['LambdaB']);
    expect(r.removed.map((x) => x.route.lambdaLogicalId)).toEqual(['LambdaA']);
  });
});
