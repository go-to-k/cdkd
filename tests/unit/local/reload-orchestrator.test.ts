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
function fakeSpec(
  logicalId: string,
  overrides: Partial<Extract<ContainerSpec, { kind: 'zip' }>> = {}
): ContainerSpec {
  return {
    kind: 'zip',
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
    } as Extract<ContainerSpec, { kind: 'zip' }>['lambda'],
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

  /**
   * IMAGE-branch `specSignature` coverage (PR #493 review G1).
   *
   * The reload-orchestrator's `specSignature` helper branches on
   * `spec.kind`. The pre-#493 review surfaced that the IMAGE branch's
   * spec-signature fields (`image` / `platform` / `command` /
   * `entryPoint` / `workingDir` / `tmpfs`) were never exercised by a
   * unit test — a regression that dropped one of those fields would
   * silently break hot reload's "Dockerfile edit → new tag → rebuild
   * containers" loop. These tests construct `kind: 'image'` fakeSpecs
   * with paired old + new shapes and assert each field's diff triggers
   * a `rebuiltLambdas` entry.
   */

  /** Build a fake IMAGE-kind ContainerSpec keyed by logical id. */
  function fakeImageSpec(
    logicalId: string,
    overrides: Partial<Extract<ContainerSpec, { kind: 'image' }>> = {}
  ): ContainerSpec {
    return {
      kind: 'image',
      lambda: {
        kind: 'image',
        stack: {} as never,
        logicalId,
        resource: {} as never,
        memoryMb: 128,
        timeoutSec: 3,
        imageUri: 'cdkd-local-start-api-abcdef0123456789',
        imageConfig: {},
        architecture: 'x86_64',
        layers: [],
      } as Extract<ContainerSpec, { kind: 'image' }>['lambda'],
      image: 'cdkd-local-start-api-abcdef0123456789',
      platform: 'linux/amd64',
      command: [],
      env: {},
      containerHost: '127.0.0.1',
      ...overrides,
    };
  }

  /** Helper: run one reload and return rebuiltLambdas for a single-Lambda diff. */
  async function runRebuildDiff(
    oldSpec: ContainerSpec,
    newSpec: ContainerSpec,
    logicalId = 'Fn'
  ): Promise<string[]> {
    const oldPool = fakePool(new Map([[logicalId, oldSpec]]));
    const newPool = fakePool(new Map([[logicalId, newSpec]]));
    let currentState: ServerState = {
      routes: [withAuth(fakeRoute({ lambdaLogicalId: logicalId }))],
      pool: oldPool,
      corsConfigByApiId: new Map(),
    };
    const orchestrator = createReloadOrchestrator({
      synthesizeAndBuild: async () => ({
        routes: [withAuth(fakeRoute({ lambdaLogicalId: logicalId }))],
        specs: new Map([[logicalId, newSpec]]),
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
    return result.rebuiltLambdas;
  }

  it('IMAGE branch: same-spec no-op leaves rebuiltLambdas empty', async () => {
    const oldSpec = fakeImageSpec('Fn');
    const newSpec = fakeImageSpec('Fn'); // identical
    expect(await runRebuildDiff(oldSpec, newSpec)).toEqual([]);
  });

  it('IMAGE branch: image-field change triggers rebuild (Dockerfile edit → new tag)', async () => {
    // Canonical hot-reload trigger for container Lambdas: the
    // deterministic tag in `image` flipped (e.g. the user edited the
    // Dockerfile and `buildContainerImage` produced a new
    // `cdkd-local-start-api-<sha>` tag).
    const oldSpec = fakeImageSpec('Fn', { image: 'cdkd-local-start-api-aaaaaaaa00000000' });
    const newSpec = fakeImageSpec('Fn', { image: 'cdkd-local-start-api-bbbbbbbb11111111' });
    expect(await runRebuildDiff(oldSpec, newSpec)).toEqual(['Fn']);
  });

  it('IMAGE branch: platform-field change triggers rebuild', async () => {
    // The Lambda's `Architectures` flipped from [x86_64] to [arm64]
    // (uncommon at runtime, but exercises that the field is in the
    // signature so a regression of dropping it would surface here).
    const oldSpec = fakeImageSpec('Fn', { platform: 'linux/amd64' });
    const newSpec = fakeImageSpec('Fn', { platform: 'linux/arm64' });
    expect(await runRebuildDiff(oldSpec, newSpec)).toEqual(['Fn']);
  });

  it('IMAGE branch: command-field change triggers rebuild', async () => {
    // `ImageConfig.Command` change — the warm container ran with the
    // old CMD; the new CMD needs a fresh start.
    const oldSpec = fakeImageSpec('Fn', { command: ['app.handler'] });
    const newSpec = fakeImageSpec('Fn', { command: ['app.v2.handler'] });
    expect(await runRebuildDiff(oldSpec, newSpec)).toEqual(['Fn']);
  });

  it('IMAGE branch: entryPoint-field change triggers rebuild', async () => {
    const oldSpec = fakeImageSpec('Fn', { entryPoint: undefined });
    const newSpec = fakeImageSpec('Fn', { entryPoint: ['/usr/bin/python3', '-u'] });
    expect(await runRebuildDiff(oldSpec, newSpec)).toEqual(['Fn']);
  });

  it('IMAGE branch: workingDir-field change triggers rebuild', async () => {
    const oldSpec = fakeImageSpec('Fn', { workingDir: undefined });
    const newSpec = fakeImageSpec('Fn', { workingDir: '/var/task' });
    expect(await runRebuildDiff(oldSpec, newSpec)).toEqual(['Fn']);
  });

  it('IMAGE branch: tmpfs-field change triggers rebuild (issue #440 EphemeralStorage)', async () => {
    // M1 review fix's actual behavior: `EphemeralStorage.Size` change
    // produces a different `tmpfs.sizeMb` and must trigger rebuild so
    // the next request sees the updated `--tmpfs /tmp:size=Nm` cap.
    const oldSpec = fakeImageSpec('Fn', { tmpfs: { target: '/tmp', sizeMb: 512 } });
    const newSpec = fakeImageSpec('Fn', { tmpfs: { target: '/tmp', sizeMb: 4096 } });
    expect(await runRebuildDiff(oldSpec, newSpec)).toEqual(['Fn']);
  });

  it('IMAGE branch: env-field change triggers rebuild', async () => {
    const oldSpec = fakeImageSpec('Fn', { env: { LEVEL: 'info' } });
    const newSpec = fakeImageSpec('Fn', { env: { LEVEL: 'debug' } });
    expect(await runRebuildDiff(oldSpec, newSpec)).toEqual(['Fn']);
  });

  it('IMAGE branch: signature does NOT confuse ZIP and IMAGE kinds', async () => {
    // Defense-in-depth: the kind discriminator must be in the
    // signature so a Lambda swapped from ZIP → IMAGE (or vice versa)
    // is always rebuilt, even if every other field happens to
    // serialize to the same JSON when one of the kinds elides a
    // field.
    const oldSpec = fakeSpec('Fn');
    const newSpec = fakeImageSpec('Fn');
    expect(await runRebuildDiff(oldSpec, newSpec)).toEqual(['Fn']);
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
