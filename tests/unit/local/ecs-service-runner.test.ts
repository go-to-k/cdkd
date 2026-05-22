import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Mock `cleanupEcsRun` so ServiceController.shutdown() tests don't need
// real docker. The mock records every call so we can assert "cleanup
// ran AFTER bootReplica populated state" in the SIGTERM-mid-restart
// race test below.
const { mockCleanup } = vi.hoisted(() => ({
  mockCleanup: vi.fn<(state: unknown, opts: { keepRunning: boolean }) => Promise<void>>(),
}));

vi.mock('../../../src/local/ecs-task-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/local/ecs-task-runner.js')>(
    '../../../src/local/ecs-task-runner.js'
  );
  return {
    ...actual,
    cleanupEcsRun: mockCleanup,
  };
});

import {
  backoffDelayMs,
  computeReplicaCount,
  createServiceRunState,
  EcsServiceRunnerError,
  ServiceController,
  shouldRestart,
  type ServiceReplicaInstance,
  type ServiceRunnerOptions,
} from '../../../src/local/ecs-service-runner.js';
import type { ResolvedEcsService } from '../../../src/local/ecs-service-resolver.js';
import type { EcsRunState } from '../../../src/local/ecs-task-runner.js';

beforeEach(() => {
  mockCleanup.mockReset();
  mockCleanup.mockResolvedValue(undefined);
});

describe('computeReplicaCount', () => {
  it('returns desiredCount when below maxTasks', () => {
    expect(computeReplicaCount(2, 5)).toBe(2);
  });

  it('clamps to maxTasks when desiredCount exceeds it', () => {
    expect(computeReplicaCount(10, 3)).toBe(3);
  });

  it('returns 1 when desiredCount is 0 (defensive — service with 0 replicas is meaningless locally)', () => {
    expect(computeReplicaCount(0, 3)).toBe(1);
  });

  it('returns 1 when desiredCount is negative', () => {
    expect(computeReplicaCount(-1, 3)).toBe(1);
  });

  it('rejects maxTasks=0 with an actionable error', () => {
    expect(() => computeReplicaCount(2, 0)).toThrow(EcsServiceRunnerError);
  });

  it('rejects negative maxTasks', () => {
    expect(() => computeReplicaCount(2, -1)).toThrow(/--max-tasks must be >= 1/);
  });

  it('equal values pass through unchanged', () => {
    expect(computeReplicaCount(3, 3)).toBe(3);
  });
});

describe('backoffDelayMs', () => {
  it('starts at 1000ms for the first restart', () => {
    expect(backoffDelayMs(0)).toBe(1000);
  });

  it('doubles each restart up to the cap', () => {
    expect(backoffDelayMs(1)).toBe(2000);
    expect(backoffDelayMs(2)).toBe(4000);
    expect(backoffDelayMs(3)).toBe(8000);
    expect(backoffDelayMs(4)).toBe(16000);
  });

  it('caps at 30000ms (30s) for high restart counts', () => {
    expect(backoffDelayMs(5)).toBe(30000);
    expect(backoffDelayMs(10)).toBe(30000);
    expect(backoffDelayMs(100)).toBe(30000);
  });
});

describe('shouldRestart', () => {
  it("'on-failure' restarts on non-zero exit", () => {
    expect(shouldRestart(1, 'on-failure')).toBe(true);
  });

  it("'on-failure' does NOT restart on zero exit (clean shutdown)", () => {
    expect(shouldRestart(0, 'on-failure')).toBe(false);
  });

  it("'on-failure' treats -1 (docker wait failure) as a restart trigger", () => {
    expect(shouldRestart(-1, 'on-failure')).toBe(true);
  });

  it("'always' restarts on every exit including 0", () => {
    expect(shouldRestart(0, 'always')).toBe(true);
    expect(shouldRestart(1, 'always')).toBe(true);
    expect(shouldRestart(-1, 'always')).toBe(true);
  });

  it("'none' never restarts", () => {
    expect(shouldRestart(0, 'none')).toBe(false);
    expect(shouldRestart(1, 'none')).toBe(false);
    expect(shouldRestart(-1, 'none')).toBe(false);
  });
});

describe('createServiceRunState', () => {
  it('returns an empty fresh run-state', () => {
    const state = createServiceRunState();
    expect(state.replicas).toEqual([]);
    expect(state.shuttingDown).toBe(false);
  });

  it('returns a new object every call (no shared mutable state across runs)', () => {
    const a = createServiceRunState();
    const b = createServiceRunState();
    expect(a).not.toBe(b);
    expect(a.replicas).not.toBe(b.replicas);
  });
});

describe('ServiceController.shutdown', () => {
  // Helper to fabricate the minimum-shaped service / options object the
  // controller needs to call cleanupEcsRun. The tests don't exercise
  // the watcher loop or runEcsTask — only the shutdown ordering.
  function fakeService(): ResolvedEcsService {
    return {
      serviceName: 'svc-test',
      serviceLogicalId: 'SvcTest',
      desiredCount: 2,
      task: {} as ResolvedEcsService['task'],
      stack: {} as ResolvedEcsService['stack'],
      warnings: [],
    } as unknown as ResolvedEcsService;
  }

  function fakeOptions(): ServiceRunnerOptions {
    return {
      maxTasks: 84,
      restartPolicy: 'on-failure',
      taskOptions: {
        cluster: 'cdkd-local',
        containerHost: '127.0.0.1',
        keepRunning: false,
      },
    };
  }

  function emptyEcsState(): EcsRunState {
    return { network: undefined, dockerVolumeNames: [], startedContainers: [], logStoppers: [] };
  }

  it('runs cleanup once even when called concurrently (singleFlight)', async () => {
    const service = fakeService();
    const runState = createServiceRunState();
    runState.replicas.push({
      index: 0,
      state: emptyEcsState(),
      restartCount: 0,
      shuttingDown: false,
      inFlightBoot: undefined,
    });
    const controller = new ServiceController(service, runState, fakeOptions());
    await Promise.all([controller.shutdown(), controller.shutdown(), controller.shutdown()]);
    expect(mockCleanup).toHaveBeenCalledTimes(1);
  });

  it('marks every replica as shuttingDown before cleanup', async () => {
    const service = fakeService();
    const runState = createServiceRunState();
    const r0: ServiceReplicaInstance = {
      index: 0,
      state: emptyEcsState(),
      restartCount: 0,
      shuttingDown: false,
      inFlightBoot: undefined,
    };
    const r1: ServiceReplicaInstance = {
      index: 1,
      state: emptyEcsState(),
      restartCount: 0,
      shuttingDown: false,
      inFlightBoot: undefined,
    };
    runState.replicas.push(r0, r1);

    let observedDuringCleanup: boolean[] = [];
    mockCleanup.mockImplementation(async () => {
      observedDuringCleanup = runState.replicas.map((r) => r.shuttingDown);
    });

    const controller = new ServiceController(service, runState, fakeOptions());
    await controller.shutdown();
    expect(observedDuringCleanup).toEqual([true, true]);
    expect(runState.shuttingDown).toBe(true);
  });

  it('awaits every in-flight bootReplica() BEFORE iterating cleanup (SIGTERM-mid-restart race fix)', async () => {
    // PR #504 review BLOCKER: the watcher's restart branch does
    // `instance.state = createEcsRunState(); await bootReplica(...)`.
    // If SIGTERM fires between those two lines, the pre-fix cleanup
    // loop ran `cleanupEcsRun()` against the freshly-allocated empty
    // state while bootReplica was still populating it — leaving the
    // docker network + sidecar bootReplica created untracked.
    //
    // Fix: the controller's shutdown() awaits every
    // `instance.inFlightBoot` Promise BEFORE iterating state for
    // cleanup. This test asserts the ordering.
    const service = fakeService();
    const runState = createServiceRunState();

    // Replica 0: simulate the SIGTERM-mid-restart scenario. The
    // `inFlightBoot` Promise resolves only after the test signals it,
    // so we can observe shutdown blocking on it.
    const populatedState = emptyEcsState();
    let resolveBoot: (() => void) | undefined;
    const bootPromise = new Promise<void>((resolve) => {
      resolveBoot = resolve;
    });
    // The boot promise, when settled, populates the state. This
    // mirrors what bootReplica() does in production code.
    const wrappedBoot = bootPromise.then(() => {
      populatedState.network = {
        name: 'cdkd-local-svc-test',
        endpointsContainerId: 'sidecar-123',
      } as EcsRunState['network'];
      populatedState.startedContainers.push({ name: 'app', id: 'container-abc' });
    });

    const r0: ServiceReplicaInstance = {
      index: 0,
      state: populatedState,
      restartCount: 1,
      shuttingDown: false,
      inFlightBoot: wrappedBoot,
    };
    runState.replicas.push(r0);

    // Capture the state seen by cleanup so we can assert it was
    // populated by the time cleanup ran.
    const observedAtCleanup: EcsRunState[] = [];
    mockCleanup.mockImplementation(async (state) => {
      observedAtCleanup.push(state as EcsRunState);
    });

    const controller = new ServiceController(service, runState, fakeOptions());
    const shutdownPromise = controller.shutdown();

    // Verify cleanup HAS NOT yet run while bootReplica is in flight.
    // Yield to the event loop a few times to make sure shutdown's
    // singleFlight body has entered the `Promise.allSettled` against
    // inFlightBoot[].
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockCleanup).not.toHaveBeenCalled();

    // Now resolve the in-flight boot, which populates the state.
    // After this, shutdown should proceed with cleanup, which should
    // see the POPULATED state (network + sidecar + container).
    if (!resolveBoot) throw new Error('test setup: resolveBoot is undefined');
    resolveBoot();
    await shutdownPromise;

    expect(mockCleanup).toHaveBeenCalledTimes(1);
    expect(observedAtCleanup).toHaveLength(1);
    const cleanedState = observedAtCleanup[0]!;
    // The populated network + container ARE visible to cleanup,
    // proving cleanup ran AFTER bootReplica finished populating state
    // (= no orphan docker network / sidecar / container).
    expect(cleanedState.network).toBeDefined();
    expect(cleanedState.network?.endpointsContainerId).toBe('sidecar-123');
    expect(cleanedState.startedContainers).toEqual([{ name: 'app', id: 'container-abc' }]);
  });

  it('handles replicas with no in-flight boot (steady state) without hanging', async () => {
    // Sanity check: when no replica is mid-restart, the in-flight
    // await branch is a no-op and shutdown proceeds straight to cleanup.
    const service = fakeService();
    const runState = createServiceRunState();
    runState.replicas.push({
      index: 0,
      state: emptyEcsState(),
      restartCount: 0,
      shuttingDown: false,
      // Explicit undefined — steady-state replica is not mid-restart.
      inFlightBoot: undefined,
    });
    const controller = new ServiceController(service, runState, fakeOptions());
    await controller.shutdown();
    expect(mockCleanup).toHaveBeenCalledTimes(1);
  });

  it('proceeds with cleanup even when in-flight bootReplica rejects', async () => {
    // A boot promise that rejects (e.g. docker run failed) should not
    // block shutdown — `Promise.allSettled` swallows the rejection.
    const service = fakeService();
    const runState = createServiceRunState();
    const rejectingBoot = Promise.reject(new Error('docker run failed'));
    // Suppress unhandled-rejection warning by attaching a catch.
    rejectingBoot.catch(() => undefined);
    runState.replicas.push({
      index: 0,
      state: emptyEcsState(),
      restartCount: 1,
      shuttingDown: false,
      inFlightBoot: rejectingBoot as Promise<void>,
    });
    const controller = new ServiceController(service, runState, fakeOptions());
    await controller.shutdown();
    expect(mockCleanup).toHaveBeenCalledTimes(1);
  });
});
