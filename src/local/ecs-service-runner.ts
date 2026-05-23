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
import type { CloudMapRegistry, RegistrationHandle } from './cloud-map-registry.js';
import type { CloudMapIndex } from './cloud-map-resolver.js';
import { getContainerNetworkIp } from './docker-inspect.js';
import type { TaskNetwork } from './ecs-network.js';

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
 * Phase 3 of #262 (Issue #460) — Cloud Map / Service Connect peer
 * discovery is wired through `ServiceRunnerOptions.discovery`. When
 * supplied, every booted replica discovers its docker IP, registers
 * itself into the shared in-process `CloudMapRegistry`, and emits
 * `--add-host` flags so consumer containers reach peer services via
 * the canonical `<discoveryName>.<namespace>` fqdn. Envoy L7 sidecar
 * emulation (design Layer B) is deferred to a follow-up PR per the
 * design's §O5 "--no-envoy by default" recommendation.
 *
 * Deferred to follow-up PRs:
 *   - Local load-balancer emulation (LB listener + target-group health
 *     check + round-robin) — separate PR per the issue's PR-split.
 *   - Envoy sidecar for Service Connect L7 routing / retries / circuit
 *     breaking (Cloud Map DNS-only mode ships now).
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
  /**
   * Issue #460 — Cloud Map / Service Connect shared registry. When
   * provided, every booted replica:
   *   1. Has its main-container IP resolved via `docker inspect`.
   *   2. Registers `(namespace, discoveryName) → ip:port` into the
   *      registry for every Service Connect entry AND every
   *      ServiceRegistry (Cloud Map service) referenced by this
   *      service.
   *   3. Re-builds its own `addHostFlags` from the registry's current
   *      snapshot so the consumer can reach previously-booted peer
   *      services via DNS overlay.
   * Pass `undefined` (single-service runs that don't need cross-
   * service discovery) to short-circuit registry interaction
   * entirely.
   */
  discovery?: ServiceDiscoveryContext;
}

/**
 * Shared Cloud Map state across all services run in one
 * `cdkd local start-service` invocation. The CLI builds this once and
 * threads the same object into every `startEcsService` call so peer
 * services discover each other through the shared `registry`.
 */
export interface ServiceDiscoveryContext {
  /** The in-process registry shared across every service in this CLI run. */
  registry: CloudMapRegistry;
  /**
   * Combined `CloudMapIndex` across every CDK stack we know about,
   * keyed by stack name so the runner can resolve a service's
   * `ServiceRegistries[].cloudMapServiceLogicalId` against the right
   * stack's index.
   */
  cloudMapIndexByStack: ReadonlyMap<string, CloudMapIndex>;
  /**
   * Single docker network shared across every replica boot in this
   * CLI invocation (design doc § 5 Option A). The CLI creates one
   * `cdkd-local-svc-<rand>` network at startup via
   * `createSharedSvcNetwork()` and tears it down at the end of the
   * run. Per-replica `runEcsTask()` calls receive this as
   * `existingNetwork` so every container joins the shared bridge —
   * peer services then reach each other by IP / network alias
   * without docker `network connect` choreography (design rejected
   * Option B for being "unwieldy and racy"). Undefined for callers
   * that opt out of shared mode (single-service runs that do not
   * need cross-service discovery).
   */
  sharedNetwork?: TaskNetwork;
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
   * Cloud Map registry handles published for this replica. Cleared on
   * cleanup so the service's discovery footprint shrinks atomically
   * with the docker network teardown. Empty when the service has no
   * Service Connect / ServiceRegistries OR when `discovery` was not
   * supplied at startEcsService time.
   */
  cloudMapHandles: RegistrationHandle[];
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
      cloudMapHandles: [],
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
        // Issue #460 — drop every Cloud Map registration for this
        // replica BEFORE tearing the network down so a peer service
        // observing the registry during shutdown doesn't briefly see
        // an unreachable endpoint.
        if (this.options.discovery) {
          for (const handle of instance.cloudMapHandles) {
            try {
              this.options.discovery.registry.unregister(handle);
            } catch {
              /* registry op is sync + best-effort */
            }
          }
          instance.cloudMapHandles = [];
        }
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
 * Build the `--network-alias` map for one service's containers (design
 * doc § 5 Option A). For every Service Connect entry, attach the
 * fqdn (`<discoveryName>.<namespaceName>`), the bare discoveryName,
 * AND every ClientAlias DnsName to the container that owns the
 * matching PortName. Other containers in the task get NO extra
 * aliases (only their default `--name`-derived alias from
 * `buildDockerRunArgs`).
 *
 * Aliases per container are de-duplicated so docker doesn't reject
 * a `--network-alias X` repeated against the same container.
 *
 * Returns an empty map when the service has no Service Connect — the
 * runner's `... .size > 0 ? { networkAliasesByContainer } : {}` guard
 * short-circuits in that case so backward-compat callers pay no cost.
 */
export function buildNetworkAliasesByContainer(
  service: ResolvedEcsService
): Map<string, ReadonlyArray<string>> {
  const out = new Map<string, string[]>();
  const sc = service.serviceConnect;
  if (!sc) return out as Map<string, ReadonlyArray<string>>;

  // PortName → container that declared it. AWS Service Connect uses
  // the first matching PortMappings[].Name to bind a service to a
  // container; cdkd mirrors that. The resolver already throws
  // `EcsTaskResolutionError` on PortName mismatch BEFORE this runs
  // (`ecs-service-resolver.ts` `extractServiceConnect`), so `owner`
  // is always defined here in production. The defensive `continue`
  // below keeps the helper testable in isolation (callers that hand
  // in a service with a deliberately mismatched PortName, which the
  // unit tests do) without throwing twice from two layers.
  for (const entry of sc.services) {
    const owner = service.task.containers.find((c) =>
      c.portMappings.some((pm) => pm.name === entry.portName)
    );
    if (!owner) continue;
    const aliases: string[] = [];
    aliases.push(entry.discoveryName);
    aliases.push(`${entry.discoveryName}.${sc.namespaceName}`);
    for (const ca of entry.clientAliases) {
      if (ca.dnsName) aliases.push(ca.dnsName);
    }
    const existing = out.get(owner.name) ?? [];
    for (const a of aliases) {
      if (!existing.includes(a)) existing.push(a);
    }
    out.set(owner.name, existing);
  }
  return out as Map<string, ReadonlyArray<string>>;
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
  const ownerKeyPrefix = `${service.serviceLogicalId}:r${instance.index}`;
  // Build per-boot `--add-host` flags from the registry's current
  // snapshot — every peer service that booted BEFORE this replica is
  // resolvable as `<discoveryName>.<namespace>` and via any bare
  // ClientAlias short-form. Exclude self entries so a service that
  // registers under, say, `frontend.cdkd-local.local` does not
  // resolve to its own previous replica.
  const addHostFlags = options.discovery?.registry
    ? options.discovery.registry.buildAddHostFlags(ownerKeyPrefix)
    : [];
  // Network strategy:
  //   - With a shared discovery network (design § 5 Option A — the
  //     CLI-built `cdkd-local-svc-<rand>` network), every replica
  //     joins the SAME docker bridge; peer services are reachable by
  //     IP / network alias without cross-network bridging. The
  //     per-replica subnet allocator is unused in this mode.
  //   - Without a shared network (defensive fallback for callers
  //     that bypass the CLI's shared-context construction), the
  //     pre-Option-A formula applies: each replica gets a per-replica
  //     subnet octet `170 + index` so concurrent replicas don't
  //     collide on a single /24 — but design § 5 Option B already
  //     rejected this for cross-service routing reasons.
  const sharedNetwork = options.discovery?.sharedNetwork;
  const networkAliasesByContainer = buildNetworkAliasesByContainer(service);
  const perReplicaTaskOptions: RunEcsTaskOptions = {
    ...options.taskOptions,
    cluster: perReplicaCluster,
    // Detach is FORCED true at the runner layer — the service runner
    // takes over essential-container monitoring (so it can restart on
    // exit) rather than letting the task runner block on
    // `waitForContainerExit`. The CLI's `--detach` flag still controls
    // whether the SERVICE runs in the background; the per-replica
    // detach is internal plumbing.
    detach: true,
    ...(sharedNetwork
      ? { existingNetwork: sharedNetwork }
      : { subnetOctet: 170 + (instance.index % 84) }),
    ...(addHostFlags.length > 0 ? { addHostFlags } : {}),
    ...(networkAliasesByContainer.size > 0 ? { networkAliasesByContainer } : {}),
  };
  logger.info(`Booting replica ${instance.index} (${perReplicaCluster})`);
  await runEcsTask(service.task, perReplicaTaskOptions, instance.state);

  // Cloud Map / Service Connect publish (Issue #460). Runs AFTER the
  // task boot so we know docker has assigned an IP. Best-effort: a
  // failed publish logs warn but does NOT abort the replica — the
  // replica is still alive, peer discovery just degrades.
  if (options.discovery) {
    await publishReplicaToCloudMap(service, instance, options.discovery, ownerKeyPrefix);
  }
}

/**
 * After the replica's main container is up, discover its docker
 * network IP and publish the configured Service Connect + Cloud Map
 * endpoints into the shared registry. The handles are tracked on the
 * instance so the shutdown / restart path can unregister symmetrically.
 *
 * Errors here are best-effort: docker inspect can fail right after run
 * (container vanished, network not fully wired), and the registry is
 * advisory — losing one replica's registration means peer services
 * can't reach it via the overlay, but it doesn't break that replica's
 * own work or AWS SDK calls.
 */
async function publishReplicaToCloudMap(
  service: ResolvedEcsService,
  instance: ServiceReplicaInstance,
  discovery: ServiceDiscoveryContext,
  ownerKeyPrefix: string
): Promise<void> {
  const logger = getLogger().child('ecs-service');
  const networkName = instance.state.network?.networkName;
  if (!networkName) return; // boot didn't get far enough to have a network

  // Pick the canonical container — Service Connect uses the producer
  // TaskDef's first essential container, mirroring AWS's ECS Agent.
  // The container's docker name is recorded in startedContainers.
  const essential = service.task.containers.find((c) => c.essential) ?? service.task.containers[0];
  if (!essential) return;
  const started = instance.state.startedContainers.find((c) => c.name === essential.name);
  if (!started) return;

  let ip: string | undefined;
  try {
    ip = await getContainerNetworkIp(started.id, networkName);
  } catch (err) {
    logger.warn(
      `Replica ${instance.index}: docker inspect failed before Cloud Map publish: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  if (!ip) {
    logger.warn(
      `Replica ${instance.index}: no docker IP discovered on network ${networkName}; ` +
        'skipping Cloud Map publish for this replica.'
    );
    return;
  }

  // Publish Service Connect entries. Each one carries:
  //   - canonical fqdn `<discoveryName>.<namespace>` (always)
  //   - bare alias `<dnsName>` for every ClientAlias with a DnsName
  if (service.serviceConnect) {
    const ns = service.serviceConnect.namespaceName;
    // Validate against the cloud-map index. The CLI passes the index
    // for the stack the service belongs to; an unmatched namespace
    // surfaces as a warn — registration still proceeds against the
    // literal name (so a CFn-but-not-CDK consumer that hand-rolled a
    // namespace can still discover the producer).
    const index = discovery.cloudMapIndexByStack.get(service.stack.stackName);
    if (index && !index.namespacesByName.has(ns)) {
      logger.warn(
        `ECS Service '${service.serviceLogicalId}' ServiceConnectConfiguration.Namespace='${ns}' ` +
          'does not match any AWS::ServiceDiscovery::PrivateDnsNamespace declared in stack ' +
          `${service.stack.stackName}. Publishing under the literal name anyway; peer services ` +
          'using the same literal will still discover this endpoint.'
      );
    }
    let i = 0;
    for (const entry of service.serviceConnect.services) {
      const ownerKey = `${ownerKeyPrefix}:sc:${i}`;
      const handle = discovery.registry.register(ns, entry.discoveryName, {
        ip,
        port: entry.containerPort,
        ownerKey,
      });
      instance.cloudMapHandles.push(handle);
      // Each ClientAlias with a DnsName becomes a bare-name alias
      // pointing at this fqdn.
      for (const alias of entry.clientAliases) {
        if (alias.dnsName) {
          discovery.registry.registerAlias(alias.dnsName, handle.fqdn);
        }
      }
      i++;
    }
  }

  // Publish ServiceRegistries[] entries. Each one references a
  // same-stack AWS::ServiceDiscovery::Service whose namespace +
  // discovery name we resolved at index-build time.
  if (service.serviceRegistries.length > 0) {
    const index = discovery.cloudMapIndexByStack.get(service.stack.stackName);
    if (!index) {
      logger.warn(
        `ECS Service '${service.serviceLogicalId}' declares ServiceRegistries[] but cdkd has ` +
          `no Cloud Map index for stack ${service.stack.stackName}. Skipping registration.`
      );
      return;
    }
    let j = 0;
    for (const reg of service.serviceRegistries) {
      const cm = index.servicesByLogicalId.get(reg.cloudMapServiceLogicalId);
      if (!cm) {
        logger.warn(
          `ECS Service '${service.serviceLogicalId}' ServiceRegistries[].cloudMapServiceLogicalId=` +
            `'${reg.cloudMapServiceLogicalId}' did not resolve to an AWS::ServiceDiscovery::Service ` +
            `in stack ${service.stack.stackName}. Skipping this registration.`
        );
        continue;
      }
      // Resolve port: explicit `ContainerPort` override > the
      // essential container's first port mapping. AWS-side
      // `ServiceRegistries[].ContainerName` (the sibling override
      // that says "register THIS container's IP rather than the
      // essential one") is intentionally IGNORED in v1 — every
      // container in the task shares the same docker network IP
      // (shared-network mode, design § 5 Option A), so picking a
      // different container would resolve to the same address.
      // Multi-IP-per-task is the `awsvpc` mode case which is itself
      // deferred to [#461]. If a sibling container exposes a
      // different port-mapping that the user wants registered, file
      // a follow-up — the in-process registry's `register()` API can
      // take the port verbatim once the resolver surfaces it.
      let port = reg.containerPort;
      if (port === undefined && essential.portMappings.length > 0) {
        port = essential.portMappings[0]!.containerPort;
      }
      if (port === undefined) {
        logger.warn(
          `ECS Service '${service.serviceLogicalId}' ServiceRegistries[] entry for Cloud Map ` +
            `service '${cm.logicalId}' has no resolvable container port; skipping.`
        );
        continue;
      }
      const ownerKey = `${ownerKeyPrefix}:sr:${j}`;
      const handle = discovery.registry.register(cm.namespaceName, cm.name, {
        ip,
        port,
        ownerKey,
      });
      instance.cloudMapHandles.push(handle);
      j++;
    }
  }
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

    // Drop Cloud Map registrations from the dying replica before its
    // network teardown — peers should not route to the about-to-be-
    // killed container.
    if (options.discovery) {
      for (const handle of instance.cloudMapHandles) {
        try {
          options.discovery.registry.unregister(handle);
        } catch {
          /* sync + best-effort */
        }
      }
      instance.cloudMapHandles = [];
    }

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

const defaultSleepImpl = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let sleepImpl: (ms: number) => Promise<void> = defaultSleepImpl;

/**
 * Test-only hook to short-circuit the restart-backoff sleep in the
 * watcher loop. Production code uses real-time `setTimeout`; the
 * canonical 1s `backoffDelayMs(0)` is too slow for a unit test poll
 * loop that wants to assert `bootCount >= 2` in <100ms.
 *
 * Restores the production `setTimeout` impl when called with `undefined`.
 */
export function __setSleepImpl(impl: ((ms: number) => Promise<void>) | undefined): void {
  if (impl === undefined) {
    sleepImpl = defaultSleepImpl;
    return;
  }
  sleepImpl = impl;
}

function sleep(ms: number): Promise<void> {
  return sleepImpl(ms);
}
