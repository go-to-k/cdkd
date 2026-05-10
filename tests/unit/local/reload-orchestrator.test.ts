import { describe, expect, it, vi } from 'vitest';
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

describe('createReloadOrchestrator', () => {
  it('atomically swaps server state on a successful reload', async () => {
    const oldSpecs = new Map([['L', fakeSpec('L')]]);
    const oldPool = fakePool(oldSpecs);
    const newSpecs = new Map([['L2', fakeSpec('L2')]]);
    const newPool = fakePool(newSpecs);
    const initialState: ServerState = {
      routes: [fakeRoute({ lambdaLogicalId: 'L' })],
      pool: oldPool,
      corsConfigByApiId: new Map(),
    };
    let currentState: ServerState = initialState;
    const orchestrator = createReloadOrchestrator({
      synthesizeAndBuild: async (): Promise<NextStateMaterial> => ({
        routes: [fakeRoute({ lambdaLogicalId: 'L2', pathPattern: '/y' })],
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
    expect(result.added.map((r) => r.lambdaLogicalId)).toEqual(['L2']);
    expect(result.removed.map((r) => r.lambdaLogicalId)).toEqual(['L']);
    // New state was swapped in.
    expect(currentState.pool).toBe(newPool);
    // Old pool was disposed (orchestrator runs it in background; await
    // a microtask flush so the test isn't racy).
    await new Promise((r) => setImmediate(r));
    expect(oldPool.disposed).toBe(true);
  });

  it('keeps previous state when synthesizeAndBuild rejects', async () => {
    const oldSpecs = new Map([['L', fakeSpec('L')]]);
    const oldPool = fakePool(oldSpecs);
    const initialState: ServerState = {
      routes: [fakeRoute({ lambdaLogicalId: 'L' })],
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
      routes: [fakeRoute({ lambdaLogicalId: 'L' })],
      pool: oldPool,
      corsConfigByApiId: new Map(),
    };
    const orchestrator = createReloadOrchestrator({
      synthesizeAndBuild: async () => ({
        routes: [fakeRoute({ lambdaLogicalId: 'L' })],
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
});
