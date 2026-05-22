import { beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';

// Mock `cleanupEcsRun` AND `runEcsTask` so ServiceController.shutdown()
// + startEcsService / bootReplica / watchReplica tests don't need real
// docker. The mocks record every call so we can assert ordering (e.g.
// "cleanup ran AFTER bootReplica populated state" in the SIGTERM-mid-
// restart race test) and trigger boot-failure paths.
const { mockCleanup, mockRunTask } = vi.hoisted(() => ({
  mockCleanup: vi.fn<(state: unknown, opts: { keepRunning: boolean }) => Promise<void>>(),
  mockRunTask:
    vi.fn<(task: unknown, opts: unknown, state: unknown) => Promise<void>>(),
}));

vi.mock('../../../src/local/ecs-task-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/local/ecs-task-runner.js')>(
    '../../../src/local/ecs-task-runner.js'
  );
  return {
    ...actual,
    cleanupEcsRun: mockCleanup,
    runEcsTask: mockRunTask,
  };
});

import {
  __setWaitForExitImpl,
  backoffDelayMs,
  computeReplicaCount,
  createServiceRunState,
  EcsServiceRunnerError,
  ServiceController,
  shouldRestart,
  startEcsService,
  type ServiceReplicaInstance,
  type ServiceRunnerOptions,
} from '../../../src/local/ecs-service-runner.js';
import type { ResolvedEcsService } from '../../../src/local/ecs-service-resolver.js';
import type { EcsRunState } from '../../../src/local/ecs-task-runner.js';

beforeEach(() => {
  mockCleanup.mockReset();
  mockCleanup.mockResolvedValue(undefined);
  mockRunTask.mockReset();
  mockRunTask.mockResolvedValue(undefined);
});

afterEach(() => {
  // Always restore the production waitForExit impl so a per-test
  // override doesn't leak into the next test's watcher loop.
  __setWaitForExitImpl(undefined);
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

describe('startEcsService / bootReplica lifecycle', () => {
  // Helpers for the lifecycle tests below. The `startEcsService` entry
  // point chains into `bootReplica` -> `runEcsTask` (mocked) and then
  // wires `watchReplica` (which polls `waitForExitImpl`, also overridable
  // via `__setWaitForExitImpl`). The tests below drive each piece
  // independently so we can assert boot-failure cleanup ordering,
  // restart-on-exit, and restart-policy degradation.
  function makeService(desiredCount = 2): ResolvedEcsService {
    return {
      serviceName: 'svc-life',
      serviceLogicalId: 'SvcLife',
      desiredCount,
      task: {
        taskDefinitionLogicalId: 'TaskDef',
        containers: [{ name: 'app', essential: true }],
      } as unknown as ResolvedEcsService['task'],
      stack: {} as ResolvedEcsService['stack'],
      warnings: [],
    } as unknown as ResolvedEcsService;
  }

  function makeOptions(
    overrides: Partial<ServiceRunnerOptions> = {}
  ): ServiceRunnerOptions {
    return {
      maxTasks: 84,
      restartPolicy: 'on-failure',
      taskOptions: {
        cluster: 'cdkd-local',
        containerHost: '127.0.0.1',
        keepRunning: false,
      },
      ...overrides,
    };
  }

  it('boot-failure on replica N>0 cleans up replicas 0..N-1', async () => {
    // First replica boots successfully (mockRunTask resolves). Second
    // replica's runEcsTask rejects, simulating e.g. an ECR pull failure
    // mid-boot of replica 1. The CLI contract is "every replica is
    // running before startEcsService returns" — so the boot failure
    // surfaces as EcsServiceRunnerError. The implementation pushes each
    // instance onto runState.replicas BEFORE awaiting bootReplica, so
    // the outer-`finally` cleanup in the CLI walks `runState.replicas`
    // and tears down the first replica even though boot of the second
    // never completed.
    mockRunTask
      .mockImplementationOnce(async (_task, _opts, state) => {
        // Populate replica 0's state so the eventual cleanup has
        // something docker-shaped to release.
        (state as EcsRunState).network = {
          name: 'cdkd-local-svc-life-r0',
          endpointsContainerId: 'sidecar-r0',
        } as EcsRunState['network'];
        (state as EcsRunState).startedContainers.push({ name: 'app', id: 'container-r0' });
      })
      .mockImplementationOnce(async () => {
        throw new Error('docker run failed for replica 1 (ECR auth)');
      });

    const service = makeService(2);
    const opts = makeOptions();
    const runState = createServiceRunState();

    await expect(startEcsService(service, opts, runState)).rejects.toThrow(
      /Failed to boot replica 1 of service 'svc-life'/
    );

    // Replica 0 was pushed onto runState.replicas BEFORE its boot
    // returned, AND replica 1 was pushed before its boot threw — both
    // are tracked, so the CLI's outer-finally cleanup loop iterates
    // both and cleanupEcsRun runs against each.
    expect(runState.replicas).toHaveLength(2);
    expect(runState.replicas[0]!.state.network?.endpointsContainerId).toBe('sidecar-r0');
    expect(runState.replicas[1]!.lastError?.message).toMatch(/docker run failed for replica 1/);

    // The runner itself does NOT auto-cleanup on boot failure —
    // teardown is the CLI's responsibility (and the controller's
    // shutdown handles it once the controller is constructed). For
    // boot-failure-before-controller, the CLI walks runState.replicas
    // directly. Simulate that path to verify the replica state is
    // recoverable.
    await Promise.all(
      runState.replicas.map((r) =>
        mockCleanup(r.state, { keepRunning: false }).catch(() => undefined)
      )
    );
    expect(mockCleanup).toHaveBeenCalledTimes(2);
    // Replica 0 cleanup sees the populated state with the docker
    // network + sidecar handles, which is the load-bearing invariant
    // for "no orphan resources on partial boot."
    expect(mockCleanup.mock.calls[0]![0]).toBe(runState.replicas[0]!.state);
  });

  it('restart-on-exit fires runEcsTask again with exponential backoff', async () => {
    // Make replica 0 boot succeed, then have its watcher loop observe
    // an exit code 1 once, restart it, observe exit code 0, and stop.
    let bootCount = 0;
    mockRunTask.mockImplementation(async (_task, _opts, state) => {
      bootCount += 1;
      const s = state as EcsRunState;
      s.network = {
        name: `cdkd-local-svc-life-boot${bootCount}`,
        endpointsContainerId: `sidecar-${bootCount}`,
      } as EcsRunState['network'];
      s.startedContainers.length = 0;
      s.startedContainers.push({ name: 'app', id: `container-${bootCount}` });
    });

    // First wait: exit code 1 (triggers restart). Second wait: exit
    // code 0 (still triggers restart under 'always' but NOT under
    // 'on-failure'). We use 'on-failure' so the loop stops after one
    // restart cycle.
    const exits = [1, 0];
    let exitIdx = 0;
    __setWaitForExitImpl(async () => {
      const code = exits[exitIdx] ?? 0;
      exitIdx += 1;
      return code;
    });

    const service = makeService(1);
    const opts = makeOptions({ restartPolicy: 'on-failure' });
    const runState = createServiceRunState();

    const controller = await startEcsService(service, opts, runState);

    // Drive the watcher loop forward. backoffDelayMs(0) is 1s — way
    // too long for a unit test, so we instead poll for `bootCount === 2`
    // with a tight overall timeout. The watcher runs in background;
    // we drain microtasks via `setImmediate` repeatedly.
    const deadline = Date.now() + 5000;
    while (bootCount < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(bootCount).toBeGreaterThanOrEqual(2);
    expect(mockRunTask).toHaveBeenCalledTimes(bootCount);
    // The replica's restartCount reflects the watcher's increment.
    expect(runState.replicas[0]!.restartCount).toBeGreaterThanOrEqual(1);

    // Shut the service down so the watcher loop exits cleanly.
    await controller.shutdown();
  });

  it("'none' restart policy leaves degraded replica down on non-zero exit", async () => {
    let bootCount = 0;
    mockRunTask.mockImplementation(async (_task, _opts, state) => {
      bootCount += 1;
      const s = state as EcsRunState;
      s.network = {
        name: `cdkd-local-svc-life-boot${bootCount}`,
        endpointsContainerId: `sidecar-${bootCount}`,
      } as EcsRunState['network'];
      s.startedContainers.length = 0;
      s.startedContainers.push({ name: 'app', id: `container-${bootCount}` });
    });

    // Watcher observes exit code 1; under 'none' policy no restart
    // fires and the replica stays down forever (service runs degraded).
    __setWaitForExitImpl(async () => 1);

    const service = makeService(1);
    const opts = makeOptions({ restartPolicy: 'none' });
    const runState = createServiceRunState();

    const controller = await startEcsService(service, opts, runState);

    // Give the watcher loop a beat to observe the exit and mark the
    // replica shuttingDown=true. `shouldRestart('none', ...) === false`
    // so the watcher should not invoke runEcsTask a second time.
    const deadline = Date.now() + 2000;
    while (!runState.replicas[0]!.shuttingDown && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Boot fired once during startEcsService, and NOT again (policy=none).
    expect(bootCount).toBe(1);
    expect(mockRunTask).toHaveBeenCalledTimes(1);
    // The replica IS marked shuttingDown by the watcher's no-restart
    // branch so activeReplicaCount() reflects the degradation.
    expect(runState.replicas[0]!.shuttingDown).toBe(true);
    expect(controller.activeReplicaCount()).toBe(0);

    await controller.shutdown();
  });

  it("'always' restart policy restarts on zero exit too", async () => {
    let bootCount = 0;
    mockRunTask.mockImplementation(async (_task, _opts, state) => {
      bootCount += 1;
      const s = state as EcsRunState;
      s.network = {
        name: `cdkd-local-svc-life-boot${bootCount}`,
        endpointsContainerId: `sidecar-${bootCount}`,
      } as EcsRunState['network'];
      s.startedContainers.length = 0;
      s.startedContainers.push({ name: 'app', id: `container-${bootCount}` });
    });

    // Successive zero-exits. Under 'always' the watcher restarts on
    // every exit including 0, mirroring ECS Service deployment behavior.
    __setWaitForExitImpl(async () => 0);

    const service = makeService(1);
    const opts = makeOptions({ restartPolicy: 'always' });
    const runState = createServiceRunState();

    const controller = await startEcsService(service, opts, runState);

    // Wait for at least one restart cycle (bootCount >= 2).
    const deadline = Date.now() + 5000;
    while (bootCount < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(bootCount).toBeGreaterThanOrEqual(2);

    await controller.shutdown();
  });

  it('successful startEcsService returns a controller with activeReplicaCount === desiredCount', async () => {
    mockRunTask.mockImplementation(async (_task, _opts, state) => {
      const s = state as EcsRunState;
      s.network = {
        name: 'cdkd-local-svc-life',
        endpointsContainerId: 'sidecar',
      } as EcsRunState['network'];
      s.startedContainers.push({ name: 'app', id: 'container-x' });
    });

    // Watcher should not observe an exit during the test — return a
    // never-resolving wait so the loop blocks past the assertions.
    __setWaitForExitImpl(() => new Promise<number>(() => undefined));

    const service = makeService(2);
    const opts = makeOptions();
    const runState = createServiceRunState();

    const controller = await startEcsService(service, opts, runState);

    expect(mockRunTask).toHaveBeenCalledTimes(2);
    expect(runState.replicas).toHaveLength(2);
    expect(controller.activeReplicaCount()).toBe(2);

    await controller.shutdown();
  });

  it('controller.shutdown cleans up every active replica (multi-replica fan-out)', async () => {
    mockRunTask.mockImplementation(async (_task, _opts, state) => {
      const s = state as EcsRunState;
      s.network = {
        name: 'cdkd-local-svc-life',
        endpointsContainerId: 'sidecar',
      } as EcsRunState['network'];
      s.startedContainers.push({ name: 'app', id: 'container-x' });
    });
    __setWaitForExitImpl(() => new Promise<number>(() => undefined));

    const service = makeService(3);
    const opts = makeOptions();
    const runState = createServiceRunState();
    const controller = await startEcsService(service, opts, runState);

    expect(controller.activeReplicaCount()).toBe(3);

    await controller.shutdown();
    // 3 cleanup calls — one per replica.
    expect(mockCleanup).toHaveBeenCalledTimes(3);
  });
});
