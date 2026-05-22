import { getLogger } from '../utils/logger.js';
import { singleFlight } from '../utils/single-flight.js';
import {
  cleanupEcsRun,
  createEcsRunState,
  runEcsTask,
  type EcsRunState,
  type RunEcsTaskOptions,
} from './ecs-task-runner.js';
import type { ResolvedEcsService } from './ecs-service-resolver.js';

/**
 * Phase 2 of #262 — long-running ECS Service emulator. Wraps the existing
 * `ecs-task-runner` machinery in a replica pool: N concurrent task
 * instances per `DesiredCount`, each with its own docker network +
 * metadata sidecar + container set. Tasks that exit non-zero AFTER the
 * health-check grace period are restarted with exponential backoff so a
 * crash-looping container does not hammer docker.
 *
 * v1 scope (per the issue's PR-split recommendation):
 *   - Replica pool sizing via `DesiredCount` clamped by `--max-tasks`.
 *   - Restart-on-exit with exponential backoff (1s → 30s, capped) +
 *     a per-instance retry counter so a permanently-broken container
 *     stops compounding cleanup work.
 *   - Long-running lifecycle (returns only on shutdown).
 *
 * Deferred to follow-up PRs:
 *   - Local load-balancer emulation (LB listener + target-group health
 *     check + round-robin) — separate PR per the issue's PR-split.
 *   - Service Connect / Cloud Map (tracked in #460).
 *   - Rolling deployment (`--reload` / `--watch`).
 */

export class EcsServiceRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcsServiceRunnerError';
    Object.setPrototypeOf(this, EcsServiceRunnerError.prototype);
  }
}

export interface ServiceRunnerOptions {
  /**
   * Hard cap on local replica count. Even when the service's
   * `DesiredCount` is high (e.g. production-shape 10+), local dev
   * machines should not have to run that many containers. Default 3 in
   * the CLI; the runner clamps to this regardless of `DesiredCount`.
   */
  maxTasks: number;
  /**
   * Restart policy on exit. Default `on-failure`: restart only when the
   * essential container exits non-zero. `always` restarts on every exit
   * (mirroring ECS Service deployment behavior more closely but produces
   * more cleanup churn). `none` skips restart entirely; the runner
   * shuts the affected replica down and the service runs degraded.
   */
  restartPolicy: 'on-failure' | 'always' | 'none';
  /**
   * Underlying per-task options. Forwarded verbatim per replica to the
   * task runner.
   */
  taskOptions: RunEcsTaskOptions;
}

/**
 * One running replica instance. The runner keeps the `EcsRunState`
 * around so the shutdown path can fan out cleanup across every
 * instance. `restartCount` lets the runner backoff before re-spinning a
 * crash-looping replica.
 */
export interface ServiceReplicaInstance {
  /** Replica index 0..desiredCount-1; load-bearing for per-instance docker network names. */
  index: number;
  state: EcsRunState;
  /** Number of restarts since service boot. Drives the backoff schedule. */
  restartCount: number;
  /** Set when the replica is being torn down so the watcher skips it. */
  shuttingDown: boolean;
  /**
   * In-flight `bootReplica()` promise when the watcher loop is mid-
   * restart (between the old state's cleanup and the new state being
   * fully populated). `ServiceController.shutdown()` awaits this BEFORE
   * iterating `instance.state.replicas` for cleanup — otherwise a
   * SIGTERM that lands between `instance.state = createEcsRunState()`
   * and `bootReplica()` finishing would call `cleanupEcsRun()` against
   * a freshly-allocated empty state while the in-flight boot was still
   * populating `instance.state.network` / `startedContainers`,
   * leaking the just-created docker network + sidecar.
   *
   * `undefined` when the replica is not currently restarting (steady
   * state — watching the running container). Declared as
   * `Promise<void> | undefined` (not `?:`) so the runner's
   * `instance.inFlightBoot = undefined` reset compiles under
   * `exactOptionalPropertyTypes`.
   */
  inFlightBoot: Promise<void> | undefined;
  /**
   * Last error from a failed run, if any. Surfaced in the shutdown
   * summary so users know why a degraded service ended up degraded.
   */
  lastError?: Error;
}

export interface ServiceRunState {
  /** All currently-tracked replicas (active OR shutting down). */
  replicas: ServiceReplicaInstance[];
  /** When true the watcher loop stops triggering restarts. */
  shuttingDown: boolean;
}

export function createServiceRunState(): ServiceRunState {
  return { replicas: [], shuttingDown: false };
}

/**
 * Compute the effective replica count for a service: the smaller of
 * `service.desiredCount` and `--max-tasks`, floored at 1. Pure-
 * functional so the CLI can show the user what cdkd is about to do
 * before any docker calls fire.
 */
export function computeReplicaCount(desiredCount: number, maxTasks: number): number {
  if (maxTasks < 1) {
    throw new EcsServiceRunnerError(
      `--max-tasks must be >= 1 (got ${maxTasks}); local dev needs at least one running replica.`
    );
  }
  if (desiredCount <= 0) return 1;
  return Math.min(desiredCount, maxTasks);
}

/**
 * Exponential backoff schedule: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ... Used
 * between restarts of a crash-looping replica so docker is not hammered
 * by the watcher loop. Exposed for unit testing.
 */
export function backoffDelayMs(restartCount: number): number {
  const base = 1000;
  const cap = 30_000;
  const factor = Math.pow(2, Math.min(restartCount, 10));
  return Math.min(base * factor, cap);
}

/**
 * Decide whether a replica that just exited should restart. Pure-
 * functional so the watcher loop's policy is easy to unit-test.
 */
export function shouldRestart(
  exitCode: number,
  policy: ServiceRunnerOptions['restartPolicy']
): boolean {
  if (policy === 'none') return false;
  if (policy === 'always') return true;
  return exitCode !== 0;
}

/**
 * Long-running entry point. Boots `replicaCount` instances of the
 * service's task descriptor, returns a controller object the CLI uses
 * to (1) wait for the first failure that gives up restarting and (2)
 * shut every replica down on SIGINT / SIGTERM.
 *
 * The returned `shutdown()` is idempotent and safe to call from
 * multiple SIGINT handlers (CLI's single-flight pattern wraps it
 * anyway).
 */
export async function startEcsService(
  service: ResolvedEcsService,
  options: ServiceRunnerOptions,
  runState: ServiceRunState
): Promise<ServiceController> {
  const logger = getLogger().child('ecs-service');
  for (const w of service.warnings) logger.warn(w);

  const replicaCount = computeReplicaCount(service.desiredCount, options.maxTasks);
  if (replicaCount < service.desiredCount) {
    logger.warn(
      `Service '${service.serviceName}' template DesiredCount=${service.desiredCount} exceeds ` +
        `--max-tasks=${options.maxTasks}; running ${replicaCount} replica(s) locally. ` +
        'Raise --max-tasks to lift the cap, or accept the reduced concurrency for local dev.'
    );
  }
  logger.info(
    `Starting ECS service '${service.serviceName}' with ${replicaCount} replica(s) ` +
      `(restartPolicy=${options.restartPolicy})`
  );

  // Boot each replica sequentially so a first-replica failure surfaces
  // before we spend `docker run` budget on the rest. Once all are up
  // the watcher loop monitors them concurrently.
  for (let i = 0; i < replicaCount; i++) {
    const instance: ServiceReplicaInstance = {
      index: i,
      state: createEcsRunState(),
      restartCount: 0,
      shuttingDown: false,
      inFlightBoot: undefined,
    };
    runState.replicas.push(instance);
    // Track the in-flight boot so a concurrent shutdown awaits it
    // before iterating `instance.state` for cleanup (same contract
    // as the watcher's restart branch — see `watchReplica` below).
    const bootPromise = bootReplica(service, options, instance);
    instance.inFlightBoot = bootPromise;
    try {
      await bootPromise;
    } catch (err) {
      // Boot failure of the FIRST replica is fatal — there is no
      // healthy replica to fall back to, and the runner contract is
      // "every replica is running before startEcsService returns".
      instance.lastError = err instanceof Error ? err : new Error(String(err));
      throw new EcsServiceRunnerError(
        `Failed to boot replica ${i} of service '${service.serviceName}': ` +
          `${instance.lastError.message}`
      );
    } finally {
      instance.inFlightBoot = undefined;
    }
  }

  // Wire each replica's exit-handler ONCE the boot is complete. The
  // watcher fires on essential-container exit and decides whether to
  // restart per `restartPolicy`.
  for (const instance of runState.replicas) {
    void watchReplica(service, options, instance, runState);
  }

  // Return the controller. The CLI keeps this alive until SIGINT.
  return new ServiceController(service, runState, options);
}

/**
 * Public controller surface. The CLI awaits `controller.waitForShutdown()`
 * to block until the user ^Cs. `controller.shutdown()` is wired into the
 * SIGINT / SIGTERM handlers.
 */
export class ServiceController {
  // Note: declared as plain fields (not parameter properties) because
  // `erasableSyntaxOnly` rejects `public readonly` constructor parameter
  // shorthand. The CLI reads `service` / `runState` / `options` so they
  // stay public-readable; runtime immutability is not enforced (TS-only
  // discipline).
  readonly service: ResolvedEcsService;
  readonly runState: ServiceRunState;
  readonly options: ServiceRunnerOptions;
  private shutdownResolve: (() => void) | undefined;
  private shutdownPromise: Promise<void>;
  /**
   * Single-flight wrapper for `shutdown()` so the fan-out cleanup runs
   * exactly once even when SIGINT and the CLI's outer `finally` both
   * fire (the canonical pattern documented in
   * `feedback_sigint_finally_cleanup_singleflight.md`). Built in the
   * constructor so every call to `shutdown()` resolves against the same
   * underlying promise.
   */
  private readonly runShutdown: () => Promise<void>;

  constructor(
    service: ResolvedEcsService,
    runState: ServiceRunState,
    options: ServiceRunnerOptions
  ) {
    this.service = service;
    this.runState = runState;
    this.options = options;
    this.shutdownPromise = new Promise<void>((resolve) => {
      this.shutdownResolve = resolve;
    });
    this.runShutdown = singleFlight(() => this.doShutdown());
  }

  /**
   * Returns the count of currently-active (non-shutting-down) replicas.
   * Exposed so the CLI can surface a one-line "service is degraded"
   * banner when restarts stop firing.
   */
  activeReplicaCount(): number {
    return this.runState.replicas.filter((r) => !r.shuttingDown).length;
  }

  /**
   * Block until `shutdown()` is called. Used by the CLI as the
   * long-running blocking point — the SIGINT handler resolves it.
   */
  waitForShutdown(): Promise<void> {
    return this.shutdownPromise;
  }

  /**
   * Idempotent fan-out shutdown across every active replica. Wired into
   * both SIGINT and the outer `finally` of the CLI command; the
   * `singleFlight`-wrapped `runShutdown` collapses concurrent / repeated
   * callers to one underlying invocation.
   */
  async shutdown(): Promise<void> {
    await this.runShutdown();
    return this.shutdownPromise;
  }

  private async doShutdown(): Promise<void> {
    this.runState.shuttingDown = true;
    const logger = getLogger().child('ecs-service');
    logger.info(`Shutting down service '${this.service.serviceName}'...`);

    // Mark every replica as shutting-down BEFORE awaiting cleanup so
    // an in-flight watcher restart cannot resurrect it mid-cleanup.
    for (const r of this.runState.replicas) r.shuttingDown = true;

    // CRITICAL: await every in-flight `bootReplica()` BEFORE iterating
    // `instance.state` for cleanup. The watcher loop's restart branch
    // assigns `instance.state = createEcsRunState()` and then awaits
    // `bootReplica()` — if SIGTERM lands between those two lines, the
    // cleanup loop would call `cleanupEcsRun()` against the freshly-
    // allocated empty state while `bootReplica()` is still populating
    // it (creating a docker network + sidecar that nobody tracks).
    // Settle every in-flight boot first so cleanup sees the populated
    // state. `Promise.allSettled` because we don't care whether the
    // boot succeeded — the goal is to wait until the state is no
    // longer being mutated.
    const inFlightBoots = this.runState.replicas
      .map((r) => r.inFlightBoot)
      .filter((p): p is Promise<void> => p !== undefined);
    if (inFlightBoots.length > 0) {
      logger.debug(
        `Awaiting ${inFlightBoots.length} in-flight bootReplica() call(s) before cleanup...`
      );
      await Promise.allSettled(inFlightBoots);
    }

    await Promise.allSettled(
      this.runState.replicas.map(async (instance) => {
        try {
          await cleanupEcsRun(instance.state, {
            keepRunning: this.options.taskOptions.keepRunning,
          });
        } catch (err) {
          logger.debug(
            `Replica ${instance.index} cleanup failed: ` +
              `${err instanceof Error ? err.message : String(err)}`
          );
        }
      })
    );
    this.shutdownResolve?.();
  }
}

/**
 * Boot a single replica. Mutates the supplied `instance.state` so the
 * shutdown path's `cleanupEcsRun(instance.state)` covers every partial
 * side effect. Network names are suffixed with the replica index so
 * docker doesn't collide on shared per-task network names when N > 1.
 */
async function bootReplica(
  service: ResolvedEcsService,
  options: ServiceRunnerOptions,
  instance: ServiceReplicaInstance
): Promise<void> {
  const logger = getLogger().child('ecs-service');
  // Per-replica cluster suffix: docker uses the network name as a key,
  // and the existing `createTaskNetwork` already appends a 6-char
  // random suffix, but using a stable replica index in the cluster
  // prefix makes per-replica logs easier to scan and prevents
  // accidental collisions if two replicas start on the same ms.
  const perReplicaCluster = `${options.taskOptions.cluster}-svc-${service.serviceLogicalId.toLowerCase()}-r${instance.index}`;
  // Per-replica subnetOctet: 170 is the AWS-documented default; each
  // additional replica walks up by 1 within the link-local 169.254.0.0/16
  // space, capped at 253 (= 170 + 83) before wrapping via `% 84`. The
  // 84-element range is the CLI cap surfaced as `MAX_TASKS_SUBNET_RANGE_CAP`
  // in `src/cli/commands/local-start-service.ts`'s `parseMaxTasks` so
  // the user gets an actionable error at parse time rather than the
  // cryptic Docker "Pool overlaps with other one" error that fires when
  // replica 84 lands on replica 0's subnet. See `buildEndpointSubnet`
  // in ecs-network.ts for the allocation contract; the cap MUST stay in
  // sync with the modulo divisor.
  const perReplicaSubnetOctet = 170 + (instance.index % 84);
  const perReplicaTaskOptions: RunEcsTaskOptions = {
    ...options.taskOptions,
    cluster: perReplicaCluster,
    subnetOctet: perReplicaSubnetOctet,
    // Detach is FORCED true at the runner layer — the service runner
    // takes over essential-container monitoring (so it can restart on
    // exit) rather than letting the task runner block on
    // `waitForContainerExit`. The CLI's `--detach` flag still controls
    // whether the SERVICE runs in the background; the per-replica
    // detach is internal plumbing.
    detach: true,
  };
  logger.info(`Booting replica ${instance.index} (${perReplicaCluster})`);
  await runEcsTask(service.task, perReplicaTaskOptions, instance.state);
}

/**
 * Long-running watcher loop for one replica. Polls the essential
 * container's exit code via `docker wait`; on exit, decides whether to
 * restart per `restartPolicy` + applies exponential backoff. The loop
 * exits only when the replica's `shuttingDown` flag is set.
 */
async function watchReplica(
  service: ResolvedEcsService,
  options: ServiceRunnerOptions,
  instance: ServiceReplicaInstance,
  runState: ServiceRunState
): Promise<void> {
  const logger = getLogger().child('ecs-service');
  while (!instance.shuttingDown && !runState.shuttingDown) {
    const essentialId = pickEssentialContainerId(instance, service);
    if (!essentialId) {
      // The container exited and was cleaned up between iterations of
      // the loop; the previous restart branch will have been the cause.
      // Break and let the outer loop's restart branch re-enter.
      await sleep(500);
      continue;
    }
    let exitCode: number;
    try {
      exitCode = await waitForExitImpl(essentialId);
    } catch (err) {
      // `docker wait` failures (e.g. container already removed) are
      // surfaced as "exited with -1" — same shape as the runner's
      // wait helper so the restart branch's decision is consistent.
      logger.debug(
        `docker wait failed for replica ${instance.index}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
      exitCode = -1;
    }
    if (instance.shuttingDown || runState.shuttingDown) return;

    logger.warn(
      `Replica ${instance.index} essential container exited with code ${exitCode} ` +
        `(restartCount=${instance.restartCount}).`
    );
    if (!shouldRestart(exitCode, options.restartPolicy)) {
      logger.warn(
        `Replica ${instance.index} not restarting (policy=${options.restartPolicy}, ` +
          `exit=${exitCode}). Service running in degraded mode.`
      );
      // Mark this replica as shutting-down so the controller's
      // `activeReplicaCount` reflects the degradation but DO NOT call
      // cleanupEcsRun here — the controller's shutdown path is the
      // single owner of teardown, and racing it from the watcher
      // corrupts the shared run-state via the same SIGINT-during-
      // cleanup pattern that `feedback_sigint_finally_cleanup_singleflight.md`
      // documents.
      instance.shuttingDown = true;
      return;
    }

    // Backoff before restarting.
    const delay = backoffDelayMs(instance.restartCount);
    logger.info(`Restarting replica ${instance.index} in ${delay}ms...`);
    await sleep(delay);
    if (instance.shuttingDown || runState.shuttingDown) return;

    // Tear down the old per-replica run-state before re-booting (else
    // the new boot collides on the docker network name).
    try {
      await cleanupEcsRun(instance.state, {
        keepRunning: false, // restart MUST clean the dead containers regardless of --keep-running
      });
    } catch (err) {
      logger.debug(
        `Replica ${instance.index} pre-restart cleanup failed: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
    instance.state = createEcsRunState();
    instance.restartCount += 1;

    // Race-safety: `instance.state = createEcsRunState()` above + the
    // upcoming `bootReplica()` populating it is the SIGTERM-mid-restart
    // hazard. Track the in-flight boot so the controller's `shutdown()`
    // can `Promise.allSettled` against it BEFORE iterating the
    // replica's state for cleanup — otherwise the cleanup loop would
    // race the boot and orphan the freshly-created docker network +
    // sidecar.
    const bootPromise = bootReplica(service, options, instance);
    instance.inFlightBoot = bootPromise;
    try {
      await bootPromise;
    } catch (err) {
      instance.lastError = err instanceof Error ? err : new Error(String(err));
      logger.error(
        `Replica ${instance.index} restart failed: ` +
          `${instance.lastError.message}. Service running in degraded mode.`
      );
      // Same single-owner rule as above — mark and exit, don't
      // cleanup from the watcher.
      instance.shuttingDown = true;
      return;
    } finally {
      instance.inFlightBoot = undefined;
    }
  }
}

function pickEssentialContainerId(
  instance: ServiceReplicaInstance,
  service?: ResolvedEcsService
): string | undefined {
  // Mirror the task runner's essential-container selection: first
  // container marked `essential: true`, else first container in
  // template order. The task runner records started containers in
  // start order (dependency-resolved), so we walk the service's task
  // descriptor (in template order) to find the first essential one
  // and look it up by name in `startedContainers`.
  if (service) {
    const essential =
      service.task.containers.find((c) => c.essential) ?? service.task.containers[0];
    if (essential) {
      const started = instance.state.startedContainers.find((c) => c.name === essential.name);
      if (started) return started.id;
    }
  }
  // Fallback: first started container. Used when the service handle
  // isn't threaded through (test-only paths).
  return instance.state.startedContainers[0]?.id;
}

/**
 * Production `docker wait <id>` implementation. Captured once so the
 * test override can restore it without duplicating the body.
 */
const defaultWaitForExitImpl = async (containerId: string): Promise<number> => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { getDockerCmd } = await import('../utils/docker-cmd.js');
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync(getDockerCmd(), ['wait', containerId], {
    maxBuffer: 1024 * 1024,
  });
  const code = parseInt(stdout.trim(), 10);
  return Number.isFinite(code) ? code : -1;
};

/**
 * `docker wait <id>` returns the exit code on stdout. Extracted as a
 * test-overridable function so unit tests do not need a real container.
 */
let waitForExitImpl: (containerId: string) => Promise<number> = defaultWaitForExitImpl;

/**
 * Test-only hook to inject a synthetic exit-code stream without docker.
 * Restores the production implementation when called with `undefined`.
 */
export function __setWaitForExitImpl(
  impl: ((containerId: string) => Promise<number>) | undefined
): void {
  if (impl === undefined) {
    waitForExitImpl = defaultWaitForExitImpl;
    return;
  }
  waitForExitImpl = impl;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
