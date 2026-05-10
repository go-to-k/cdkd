import { getLogger } from '../utils/logger.js';
import { pickFreePort, removeContainer, runDetached, streamLogs } from './docker-runner.js';
import type { ResolvedZipLambda } from './lambda-resolver.js';
import { waitForRieReady } from './rie-client.js';
import { resolveRuntimeImage } from './runtime-image.js';

/**
 * Per-Lambda warm container pool for `cdkd local start-api` (D8.3).
 *
 * Two design forces:
 *
 *   1. **Concurrency**: a single Lambda RIE container serializes invokes
 *      on its own. Modern HTTP API integrations / browser fanout makes
 *      that immediately visible. Default pool size 2 (warm + 1 cold
 *      backup); `--per-lambda-concurrency` raises to max 4.
 *
 *   2. **Resource budget**: idle containers cost RAM. After 60s of
 *      inactivity an entry's idle handles are torn down — the next
 *      request pays a fresh start cost.
 *
 * Implementation:
 *
 *   - `Map<logicalId, ContainerPoolEntry>` keyed by Lambda logical ID.
 *   - Per-entry `acquire()` / `release()` use a tiny mutex chain
 *     (`growthMutex`) to serialize lazy growth. `acquire()` returns the
 *     first idle handle; if all are in use and the pool is below the
 *     cap, lazy-starts a new one; if all in use AND at the cap, the
 *     waiter joins a `waitQueue` flushed by `release()`.
 *
 *   - `dispose()` cancels every idle timer, removes every container, and
 *     **tolerates per-container removal failures** — logged at warn,
 *     loop continues. The verify.sh trap (`docker rm -f` over every
 *     `cdkd-local-*` container) is the safety net.
 */

export interface ContainerHandle {
  logicalId: string;
  containerId: string;
  containerName: string;
  hostPort: number;
  containerHost: string;
  /** Stop the streaming-logs child process attached at boot. */
  stopLogStream: () => void;
}

interface ContainerPoolEntry {
  logicalId: string;
  /** Currently idle handles ready to be `acquire()`d. */
  warm: ContainerHandle[];
  /** Currently in-use handles. */
  inUse: Set<ContainerHandle>;
  /**
   * Resolvers for `acquire()` calls that are blocked because every
   * handle is in use AND `pool.size === concurrencyCap`. Released by
   * the next `release()`. `dispose()` rejects every pending waiter
   * via the `reject` callback so the request handler returns 502
   * instead of hanging forever.
   */
  waitQueue: Array<{ resolve: (h: ContainerHandle) => void; reject: (err: Error) => void }>;
  /** 60s idle GC timer, reset on every `release()`. */
  idleTimer: NodeJS.Timeout | null;
  /** Serializes lazy growth so two concurrent `acquire()`s don't double-start. */
  growthMutex: Promise<void>;
}

/**
 * Per-Lambda parameters used to spin up a container. Set once at server
 * boot — `acquire()` reads these from the pool's per-logical-id record.
 */
export interface ContainerSpec {
  /**
   * `cdkd local start-api` v1 supports ZIP Lambdas only. Container-image
   * Lambdas (PR 5 of #224) are rejected at the resolver layer in
   * `local-start-api.ts` with a clear error pointing at PR 8b/c.
   */
  lambda: ResolvedZipLambda;
  /** Bind-mount source for `/var/task` (asset dir or materialized inline). */
  codeDir: string;
  /**
   * Pre-resolved bind-mount source for `/opt` (PR 6 of #224, issue
   * #232 — Lambda Layers). Resolved ONCE at server boot — for a
   * single-layer function this is the layer's asset dir; for multi-
   * layer functions this is a tmpdir that already merged the layers
   * in template order (later layers overwrite earlier files via
   * `cpSync({force: true})`). Undefined when the function declares
   * no layers. Why pre-resolve at the server level instead of per
   * cold-start: the merge is deterministic (templates are
   * static for the server's lifetime) and we want exactly ONE merged
   * dir to clean up at dispose.
   */
  optDir?: string;
  env: Record<string, string>;
  containerHost: string;
  /** Optional Node.js `--inspect-brk` port. */
  debugPort?: number;
}

export interface ContainerPoolOptions {
  /** Per-Lambda max concurrency (default 2, max 4). */
  perLambdaConcurrency: number;
  /** Whether to skip `docker pull`. The CLI's `--no-pull`. */
  skipPull?: boolean;
  /** Idle GC delay in ms. Defaults to 60_000; tests override via fake timers. */
  idleMs?: number;
  /** Whether to attach `docker logs -f` per container. Default true. */
  streamLogs?: boolean;
}

export interface ContainerPool {
  /**
   * Acquire (or lazy-start) a warm container for the given Lambda. The
   * caller MUST eventually `release(handle)` — every code path through
   * the request handler runs `release` from a `finally`.
   */
  acquire(logicalId: string): Promise<ContainerHandle>;
  /** Mark a handle idle and reset its 60s idle GC timer. */
  release(handle: ContainerHandle): void;
  /** Tear down every container (warm + in-use). Tolerates removal failures. */
  dispose(): Promise<void>;
}

const DEFAULT_IDLE_MS = 60_000;
const MAX_PER_LAMBDA_CONCURRENCY = 4;
const MIN_PER_LAMBDA_CONCURRENCY = 1;

/**
 * Construct a ContainerPool. The `specs` map is keyed by logical ID; only
 * Lambdas in that map are reachable via `acquire()`. The pool starts
 * empty unless `prewarm: true` (a one-shot best-effort warm pass at
 * server boot — failures don't abort the server, they just mean the
 * first request to that Lambda pays cold-start cost).
 */
export function createContainerPool(
  specs: Map<string, ContainerSpec>,
  options: ContainerPoolOptions
): ContainerPool {
  const logger = getLogger().child('container-pool');
  const concurrencyCap = clampConcurrency(options.perLambdaConcurrency);
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const streamingEnabled = options.streamLogs !== false;

  const entries = new Map<string, ContainerPoolEntry>();

  /**
   * Tracks every in-flight `startOne` promise so `dispose()` can wait
   * for them (with a short timeout) and tear down the resulting
   * handles instead of leaking the container. Without this, a SIGINT
   * during a cold-start lands on an `acquire()` that's still inside
   * `runDetached` / `waitForRieReady`; when the start eventually
   * resolves, `entries.get(...)` is undefined and the handle is
   * dropped on the floor. Populated inside `startOne`'s entry path
   * (via `trackStart`); drained in `dispose()`.
   */
  const inFlightStarts = new Set<Promise<ContainerHandle>>();

  // Pre-create empty entries so `acquire()` never has to lazily build
  // the map under contention. Pool starts at size 0 per entry; growth
  // happens inside `acquire()` under the per-entry mutex.
  for (const logicalId of specs.keys()) {
    entries.set(logicalId, emptyEntry(logicalId));
  }

  function emptyEntry(logicalId: string): ContainerPoolEntry {
    return {
      logicalId,
      warm: [],
      inUse: new Set(),
      waitQueue: [],
      idleTimer: null,
      growthMutex: Promise.resolve(),
    };
  }

  /**
   * Spin up one new container for the given Lambda spec. Returns a
   * handle the caller can write into the entry's data structures.
   */
  async function startOne(spec: ContainerSpec): Promise<ContainerHandle> {
    const image = resolveRuntimeImage(spec.lambda.runtime);
    const hostPort = await pickFreePort();
    const name = `cdkd-local-${spec.lambda.logicalId}-${process.pid}-${Math.floor(
      Math.random() * 1_000_000
    )}`;
    logger.debug(
      `Starting container ${name} for ${spec.lambda.logicalId} on ${spec.containerHost}:${hostPort}`
    );
    // PR 6 (#232): one pre-resolved bind mount at `/opt` (when the
    // function declares any layers). Multi-layer merging happens in
    // `local-start-api.ts`'s `materializeLambdaLayers(...)` once at
    // server boot — Docker rejects two `-v ...:/opt:ro` entries at
    // the same target, so cdkd can't rely on overlay layering and
    // must merge on the host instead (see ImagePlan.layersTmpDir
    // docstring in `cli/commands/local-invoke.ts`).
    const optMount = spec.optDir
      ? [{ hostPath: spec.optDir, containerPath: '/opt', readOnly: true }]
      : [];
    const containerId = await runDetached({
      image,
      mounts: [{ hostPath: spec.codeDir, containerPath: '/var/task', readOnly: true }],
      extraMounts: optMount,
      env: spec.env,
      cmd: [spec.lambda.handler],
      hostPort,
      host: spec.containerHost,
      name,
      ...(spec.debugPort !== undefined && { debugPort: spec.debugPort }),
    });
    const stopLogStream = streamingEnabled ? streamLogs(containerId) : (): void => undefined;
    try {
      await waitForRieReady(spec.containerHost, hostPort, 30_000);
    } catch (err) {
      // RIE didn't start — clean up before propagating.
      stopLogStream();
      await removeContainer(containerId).catch(() => undefined);
      throw err;
    }
    return {
      logicalId: spec.lambda.logicalId,
      containerId,
      containerName: name,
      hostPort,
      containerHost: spec.containerHost,
      stopLogStream,
    };
  }

  /**
   * Serialize a body of work behind the entry's growth mutex so two
   * `acquire()`s racing against the cap don't both try to lazy-start
   * (which would double the pool size + leak a container).
   */
  async function withMutex<T>(entry: ContainerPoolEntry, body: () => Promise<T>): Promise<T> {
    const previous = entry.growthMutex;
    let release!: () => void;
    entry.growthMutex = new Promise<void>((r) => (release = r));
    try {
      await previous;
      return await body();
    } finally {
      release();
    }
  }

  /**
   * Tear down one container; tolerate every kind of failure. Called from
   * the idle GC timer and from `dispose()`.
   */
  async function tearDown(handle: ContainerHandle): Promise<void> {
    try {
      handle.stopLogStream();
    } catch (err) {
      logger.debug(
        `stopLogStream(${handle.containerName}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    try {
      await removeContainer(handle.containerId);
    } catch (err) {
      logger.warn(
        `Failed to remove container ${handle.containerName}: ${err instanceof Error ? err.message : String(err)}. Continuing cleanup.`
      );
    }
  }

  function poolSize(entry: ContainerPoolEntry): number {
    return entry.warm.length + entry.inUse.size;
  }

  function resetIdleTimer(entry: ContainerPoolEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    if (entry.warm.length === 0) return;
    entry.idleTimer = setTimeout(() => {
      void gcIdle(entry);
    }, idleMs);
    // Don't keep the Node event loop open just for the GC timer — when
    // the user hits ^C we want graceful shutdown to be able to exit.
    entry.idleTimer.unref?.();
  }

  /**
   * Idle GC: tear down every warm handle for the entry. Called by the
   * 60s timer; fired-and-forget so a slow `removeContainer` doesn't
   * block the timer queue.
   */
  async function gcIdle(entry: ContainerPoolEntry): Promise<void> {
    const handles = entry.warm.splice(0, entry.warm.length);
    entry.idleTimer = null;
    if (handles.length === 0) return;
    logger.debug(`Idle GC: tearing down ${handles.length} container(s) for ${entry.logicalId}`);
    await Promise.allSettled(handles.map((h) => tearDown(h)));
  }

  return {
    async acquire(logicalId: string): Promise<ContainerHandle> {
      const entry = entries.get(logicalId);
      if (!entry) {
        throw new Error(
          `containerPool.acquire: no spec registered for Lambda '${logicalId}'. This is a bug — every reachable route's Lambda should be registered at server boot.`
        );
      }

      // Fast path: an idle warm handle exists.
      if (entry.warm.length > 0) {
        const handle = entry.warm.shift()!;
        entry.inUse.add(handle);
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer);
          entry.idleTimer = null;
        }
        return handle;
      }

      // No idle handle. Either grow the pool (if below cap) or wait.
      // Grab the mutex to serialize the size check + grow decision.
      return await withMutex(entry, async () => {
        // Re-check the warm list inside the mutex — a concurrent
        // `release()` may have flipped a handle back to warm.
        if (entry.warm.length > 0) {
          const handle = entry.warm.shift()!;
          entry.inUse.add(handle);
          return handle;
        }

        if (poolSize(entry) < concurrencyCap) {
          const spec = specs.get(logicalId)!;
          // Track the start promise so `dispose()` can wait for it (with
          // a timeout) and tear down the resulting container instead of
          // leaking it on a SIGINT-during-cold-start race.
          const startPromise = startOne(spec);
          inFlightStarts.add(startPromise);
          let handle: ContainerHandle;
          try {
            handle = await startPromise;
          } finally {
            inFlightStarts.delete(startPromise);
          }
          entry.inUse.add(handle);
          return handle;
        }

        // At the cap — wait for a release.
        return await new Promise<ContainerHandle>((resolveAcquire, rejectAcquire) => {
          entry.waitQueue.push({ resolve: resolveAcquire, reject: rejectAcquire });
        });
      });
    },

    release(handle: ContainerHandle): void {
      const entry = entries.get(handle.logicalId);
      if (!entry) return;
      entry.inUse.delete(handle);

      // Hand off to a waiting `acquire()` if any.
      const waiter = entry.waitQueue.shift();
      if (waiter) {
        entry.inUse.add(handle);
        waiter.resolve(handle);
        return;
      }

      // Otherwise return to the warm list and (re)arm the idle GC.
      entry.warm.push(handle);
      resetIdleTimer(entry);
    },

    async dispose(): Promise<void> {
      logger.debug('Disposing container pool');
      const allHandles: ContainerHandle[] = [];
      for (const entry of entries.values()) {
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer);
          entry.idleTimer = null;
        }
        // Reject any pending waiters with a clear error. They'll surface
        // as 502s through the request handler's catch.
        for (const waiter of entry.waitQueue.splice(0, entry.waitQueue.length)) {
          try {
            waiter.reject(
              new Error(`Container pool disposed while ${entry.logicalId} was waiting`)
            );
          } catch {
            /* swallow */
          }
        }
        allHandles.push(...entry.warm.splice(0, entry.warm.length));
        for (const h of entry.inUse) allHandles.push(h);
        entry.inUse.clear();
      }

      // Wait for any cold-start `startOne` calls that were mid-flight at
      // dispose time, with a short timeout so a hung docker-run can't
      // block shutdown forever. Each settled start contributes its
      // resulting handle to the teardown set so the container does not
      // leak (the verify.sh `docker rm -f cdkd-local-*` sweep is a
      // safety net for the timeout case).
      const startPromises = [...inFlightStarts];
      if (startPromises.length > 0) {
        logger.debug(
          `Waiting for ${startPromises.length} in-flight container start(s) to settle before teardown`
        );
        const drainTimeoutMs = 5_000;
        const wrapped = startPromises.map((p) =>
          Promise.race([
            p.then((h): { kind: 'ok'; handle: ContainerHandle } => ({ kind: 'ok', handle: h })),
            new Promise<{ kind: 'timeout' }>((r) => {
              const t = setTimeout(() => r({ kind: 'timeout' }), drainTimeoutMs);
              t.unref?.();
            }),
          ]).catch((err: unknown) => {
            // `startOne` rejected — log and skip; nothing to tear down.
            logger.debug(
              `In-flight startOne rejected during dispose: ${err instanceof Error ? err.message : String(err)}`
            );
            return { kind: 'rejected' as const };
          })
        );
        const results = await Promise.all(wrapped);
        let timedOut = 0;
        for (const r of results) {
          if (r.kind === 'ok') {
            allHandles.push(r.handle);
          } else if (r.kind === 'timeout') {
            timedOut++;
          }
        }
        if (timedOut > 0) {
          logger.warn(
            `Container pool disposed with ${timedOut} in-flight start(s) still pending after ${drainTimeoutMs}ms; relying on docker --rm + the verify.sh sweep to clean up.`
          );
        }
        inFlightStarts.clear();
      }

      // Tear down in parallel; `tearDown` swallows individual failures.
      await Promise.allSettled(allHandles.map((h) => tearDown(h)));
      entries.clear();
    },
  };
}

/**
 * Validate / clamp the per-Lambda concurrency cap. Defense-in-depth: the
 * CLI parser also bounds the value, but this guarantees the pool stays
 * predictable when called programmatically (e.g. from tests).
 */
function clampConcurrency(input: number): number {
  if (!Number.isFinite(input)) return 2;
  return Math.min(
    MAX_PER_LAMBDA_CONCURRENCY,
    Math.max(MIN_PER_LAMBDA_CONCURRENCY, Math.trunc(input))
  );
}
