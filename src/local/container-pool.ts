import { isPasteableIdent, safeMsg } from '../utils/display-safe.js';
import { getLogger } from '../utils/logger.js';
import { quotedOrDescribed } from '../utils/pasteable-command.js';
import { pickFreePort, removeContainer, runDetached, streamLogs } from './docker-runner.js';
import type { ResolvedImageLambda, ResolvedZipLambda } from './lambda-resolver.js';
import { waitForRieReady } from './rie-client.js';
import { resolveRuntimeCodeMountPath, resolveRuntimeImage } from './runtime-image.js';

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
  /**
   * Resolvers waiting for `inUse` to fully drain. Populated by
   * `dispose()` and resolved by `release()` whenever `inUse.size` hits
   * zero. Allows `dispose()` to await every in-flight handle before
   * tearing down — without this guard a request mid-`invokeRie` against
   * the pool would have its container killed (502 leak) AND a stale
   * `release(handle)` from its `finally` block would corrupt the
   * post-dispose entries map (the bug described in the PR review).
   */
  drainResolvers: Array<() => void>;
}

/**
 * Per-Lambda parameters used to spin up a container. Set once at server
 * boot — `acquire()` reads these from the pool's per-logical-id record.
 *
 * Discriminated union (closes #453): `kind === 'zip'` for traditional
 * ZIP-packaged Lambdas (Node.js / Python / Ruby / Java / etc. — base image
 * comes from `public.ecr.aws/lambda/<lang>:<v>`, code bind-mounted at
 * `/var/task` or `/var/runtime`); `kind === 'image'` for container Lambdas
 * (`Code.ImageUri` — image already includes the code, no bind mount,
 * `ImageConfig.Command` / `EntryPoint` / `WorkingDirectory` drive
 * invocation). The shared fields (`env`, `containerHost`, `debugPort`)
 * apply to both variants.
 */
export type ContainerSpec = ZipContainerSpec | ImageContainerSpec;

interface ContainerSpecBase {
  env: Record<string, string>;
  containerHost: string;
  /** Optional Node.js `--inspect-brk` port. */
  debugPort?: number;
  /**
   * Optional sized tmpfs mount for the warm container (issue #440 —
   * Lambda `Properties.EphemeralStorage.Size`). Resolved ONCE at server
   * boot from the function's template (same as `optDir` / `codeDir`)
   * and threaded into every cold-start of this Lambda's pool. Unset
   * when the template did not declare `EphemeralStorage` — the warm
   * container's `/tmp` is then whatever the base image provides
   * (preserves the pre-#440 behavior). Target path is `/tmp`. Applies
   * to BOTH ZIP and IMAGE Lambdas — Docker `--tmpfs` overlays inside
   * any container image just like on the public base images.
   */
  tmpfs?: { target: string; sizeMb: number };
  /**
   * Extra `--add-host` mappings forwarded to `docker run`. Used by
   * `cdkd local start-api`'s WebSocket support (#462) to inject
   * `host.docker.internal:host-gateway` so Lambdas backing
   * WebSocket APIs can reach the host's `@connections` HTTP
   * endpoint when calling `apigatewaymanagementapi:PostToConnection`.
   * Resolved once at server boot (alongside `tmpfs` / `env`) and
   * threaded into every cold-start of this Lambda's pool. Empty
   * for Lambdas not backing a WebSocket API.
   */
  extraHosts?: { host: string; ip: string }[];
  /**
   * Issue #2-deferred-from-#655 — when `cdkd local *` is invoked with
   * `--profile <name>`, this is the host path of a synthesized AWS shared
   * credentials file (one INI section, the resolved `[<name>]` block).
   * The pool bind-mounts it read-only at the container path so SDK calls
   * via `fromIni({ profile: '<name>' })` inside the handler find their
   * profile locally — production AWS Lambda doesn't ship `~/.aws/`, so
   * this is purely a local-development convenience to keep handler code
   * portable without source changes.
   *
   * Set in `local-start-api.ts` / `local-invoke.ts`'s startup flow
   * alongside the `AWS_SHARED_CREDENTIALS_FILE` + `AWS_PROFILE` env
   * entries (already in `env`) so the SDK's default chain + explicit
   * `fromIni({ profile })` both resolve to the same creds. Unset when
   * `--profile` was not passed (the env-var-only path stays in effect).
   */
  profileCredentialsFile?: { hostPath: string; containerPath: string };
}

export interface ZipContainerSpec extends ContainerSpecBase {
  kind: 'zip';
  /**
   * The ZIP Lambda's resolved metadata. The pool reads `runtime` to pick
   * the base image and code mount path, `handler` for the container CMD,
   * and `logicalId` for the docker container name + log prefix.
   */
  lambda: ResolvedZipLambda;
  /**
   * Bind-mount source for the in-container deployment path. The target
   * path is `/var/task` for most runtimes and `/var/runtime` for the
   * `provided.al2` / `provided.al2023` OS-only runtimes — chosen by
   * `resolveRuntimeCodeMountPath(spec.lambda.runtime)` at acquire time.
   * Source is the asset dir or materialized inline tmpdir.
   */
  codeDir: string;
  /**
   * `docker run --platform <linux/amd64|linux/arm64>` translated from the
   * ZIP Lambda's `Architectures` array (issue #768). Threaded through to
   * the ZIP container's `docker run` so a `provided.*` `bootstrap`
   * compiled for the other arch doesn't fail with `exec format error` /
   * `Runtime.InvalidEntrypoint` on an arch-mismatched host — matching the
   * IMAGE spec, which already carries `platform`.
   */
  platform: string;
  /**
   * Pre-resolved bind-mount source for `/opt` (PR 6 of #224, issue
   * #232 — Lambda Layers). Resolved ONCE at server boot — for a
   * single-layer function this is the layer's asset dir; for multi-
   * layer functions this is a tmpdir that already merged the layers
   * in template order (later layers overwrite earlier files via
   * `copyLayerTreeLastWins`). Undefined when the function declares
   * no layers. Why pre-resolve at the server level instead of per
   * cold-start: the merge is deterministic (templates are
   * static for the server's lifetime) and we want exactly ONE merged
   * dir to clean up at dispose.
   */
  optDir?: string;
}

export interface ImageContainerSpec extends ContainerSpecBase {
  kind: 'image';
  /**
   * The container Lambda's resolved metadata. The pool reads `logicalId`
   * for the docker container name + log prefix. `runtime` / `handler`
   * are NOT set on the IMAGE branch (AWS contract: container Lambdas
   * don't have `Handler` — invocation is driven by `ImageConfig.Command`
   * or the image's own CMD; `Runtime` is also absent).
   */
  lambda: ResolvedImageLambda;
  /**
   * Pre-built local docker image tag / reference. Resolved ONCE at
   * server boot via `buildContainerImage` (local-build path against
   * `cdk.out` asset manifest) or `pullEcrImage` (ECR-pull fallback; the ECR
   * client is built for the image URI's own region, so cross-region pulls
   * work — see `src/local/ecr-puller.ts`). The pool passes this verbatim to `docker
   * run` — no further resolution happens on the per-cold-start path.
   *
   * On hot reload (`--watch`) `reloadAllServers` in `local-start-api.ts`
   * builds a fresh pool from the re-synthesized specs and disposes the
   * previous one, so a changed `image` (e.g. the user edited the
   * Dockerfile and the deterministic tag flipped) is what the next
   * cold-start runs.
   */
  image: string;
  /**
   * `docker run --platform <linux/amd64|linux/arm64>` translated from
   * the Lambda's `Architectures` array. Threaded through to BOTH the
   * `docker build` (`buildContainerImage`) AND the `docker run` step
   * so an arm64 host running an x86_64 Lambda doesn't hit silent
   * emulation, and an x86_64 host running an arm64 Lambda doesn't
   * fail with `exec format error`.
   */
  platform: string;
  /**
   * `ImageConfig.Command` from the template. Empty array when the user
   * relies on the image's own CMD (the common case for `LAMBDA_TASK_ROOT`-
   * convention images). Forwarded as the CMD slot of `docker run`.
   */
  command: string[];
  /**
   * `ImageConfig.EntryPoint` from the template. Undefined when the user
   * relies on the image's default entrypoint (typically
   * `/lambda-entrypoint.sh` on AWS base images, which routes to RIE).
   * When set, the first entry maps to `docker run --entrypoint <first>`
   * and the rest are prepended to `cmd` as positional args — see
   * `docker-runner.ts:runDetached`.
   */
  entryPoint?: string[];
  /**
   * `ImageConfig.WorkingDirectory` → `docker run --workdir <dir>`.
   * Undefined when the image's own WORKDIR is sufficient.
   */
  workingDir?: string;
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
/**
 * How long `dispose()` waits for an in-flight container start before removing
 * the container by its `--name` (issue #4495). `docker run` has no timeout of
 * its own and a terminal ^C does not interrupt it, so a hung daemon would
 * otherwise hold the shutdown forever.
 */
export const IN_FLIGHT_START_TIMEOUT_MS = 20_000;
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
  // Set once `dispose()` runs, so a stale `release(handle)` from a
  // request whose `finally` block raced the dispose teardown becomes a
  // no-op instead of corrupting the post-dispose entries map (entry
  // removed → release would push the handle into a freed `warm[]` and
  // re-arm the idle timer on a torn-down entry). The verify.sh
  // `docker rm -f cdkd-local-*` sweep is the safety net for the
  // not-yet-torn-down container itself.
  let disposed = false;
  /** `dispose()`'s run, so a second call waits for the first (issue #4495). */
  let disposeRun: Promise<void> | undefined;
  /**
   * One per start waiting for RIE readiness: `dispose()` calls each, so that
   * start stops waiting and removes its container (issue #4495). A start
   * removes its own on finishing, so none outlives it.
   */
  const disposeWaiters = new Set<() => void>();

  /**
   * Tracks every in-flight `startOne` promise so `dispose()` can wait
   * for them (with a short timeout) and tear down the resulting
   * handles instead of leaking the container. Without this, a SIGINT
   * during a cold-start lands on an `acquire()` that's still inside
   * `runDetached` / `waitForRieReady`; when the start eventually
   * resolves, `entries.get(...)` is undefined and the handle is
   * dropped on the floor. Populated inside `startOne`'s entry path
   * (via `trackStart`); drained in `dispose()`. Each maps to the
   * container's `--name`, which `dispose()` removes by when the start does
   * not settle in time.
   */
  const inFlightStarts = new Map<Promise<ContainerHandle>, string>();

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
      drainResolvers: [],
    };
  }

  /**
   * Spin up one new container for the given Lambda spec. Returns a
   * handle the caller can write into the entry's data structures.
   *
   * Branches on `spec.kind`:
   *   - `'zip'`: bind-mount the function's local code dir at
   *     `/var/task` (or `/var/runtime` for `provided.*` runtimes),
   *     base image from `public.ecr.aws/lambda/<lang>:<v>`, CMD =
   *     `[<Handler>]`.
   *   - `'image'`: no code bind-mount (image already includes the
   *     code), base image is the pre-built local tag, CMD =
   *     `ImageConfig.Command` (may be empty), optional EntryPoint /
   *     WorkingDirectory / --platform applied verbatim.
   */
  async function startOne(spec: ContainerSpec, name: string): Promise<ContainerHandle> {
    const hostPort = await pickFreePort();
    // Once `dispose()` began, start nothing (issue #4495).
    if (disposed) throw disposedDuringStart(spec);
    logger.debug(
      `Starting container ${name} for ${spec.lambda.logicalId} (kind=${spec.kind}) on ${spec.containerHost}:${hostPort}`
    );

    let containerId: string;
    if (spec.kind === 'zip') {
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
      // Append the profile credentials file mount (issue #2 deferred from
      // #655) when --profile was passed. Read-only — the container has no
      // business writing to its credentials file, and a writable mount
      // would let a compromised handler tamper with the host-side temp
      // file. Combined with `optMount` since Docker accepts an array of
      // -v args (no conflict with the /opt layer mount).
      const extraMounts = spec.profileCredentialsFile
        ? [
            ...optMount,
            {
              hostPath: spec.profileCredentialsFile.hostPath,
              containerPath: spec.profileCredentialsFile.containerPath,
              readOnly: true,
            },
          ]
        : optMount;
      // provided.al2 / provided.al2023 require the deployment package at
      // /var/runtime (where the base image's hardcoded entrypoint exec's
      // /var/runtime/bootstrap); every other runtime expects /var/task.
      const containerCodePath = resolveRuntimeCodeMountPath(spec.lambda.runtime);
      const image = resolveRuntimeImage(spec.lambda.runtime);
      containerId = await removedIfDisposedOnFailure(
        name,
        runDetached({
          image,
          mounts: [{ hostPath: spec.codeDir, containerPath: containerCodePath, readOnly: true }],
          extraMounts,
          env: spec.env,
          cmd: [spec.lambda.handler],
          hostPort,
          host: spec.containerHost,
          name,
          // Issue #768: pin the ZIP container to the function's declared arch
          // so a `provided.*` cross-arch `bootstrap` runs under emulation
          // instead of failing with `exec format error`.
          platform: spec.platform,
          ...(spec.debugPort !== undefined && { debugPort: spec.debugPort }),
          ...(spec.tmpfs !== undefined && { tmpfs: spec.tmpfs }),
          ...(spec.extraHosts !== undefined && { extraHosts: spec.extraHosts }),
        })
      );
    } else {
      // IMAGE branch (closes #453). The pre-built local tag is on
      // `spec.image`; the architecture-derived `--platform` is on
      // `spec.platform`. `ImageConfig` fields drive CMD / entrypoint /
      // workdir verbatim. No bind mounts: the image already contains
      // the function code at its built-in `/var/task`. AWS layers are
      // baked into the image at build time, not overlaid at runtime,
      // so we never emit a `/opt` mount on this branch (matches the
      // AWS-side invoke behavior). `tmpfs` (#440) applies inside any
      // container image just like on the public base images.
      containerId = await removedIfDisposedOnFailure(
        name,
        runDetached({
          image: spec.image,
          mounts: [],
          ...(spec.profileCredentialsFile && {
            extraMounts: [
              {
                hostPath: spec.profileCredentialsFile.hostPath,
                containerPath: spec.profileCredentialsFile.containerPath,
                readOnly: true,
              },
            ],
          }),
          env: spec.env,
          cmd: spec.command,
          hostPort,
          host: spec.containerHost,
          name,
          platform: spec.platform,
          ...(spec.entryPoint !== undefined && { entryPoint: spec.entryPoint }),
          ...(spec.workingDir !== undefined && { workingDir: spec.workingDir }),
          ...(spec.debugPort !== undefined && { debugPort: spec.debugPort }),
          ...(spec.tmpfs !== undefined && { tmpfs: spec.tmpfs }),
          ...(spec.extraHosts !== undefined && { extraHosts: spec.extraHosts }),
        })
      );
    }
    // `dispose()` began while `docker run` was in flight: remove the container
    // here, before this start settles, since `dispose()` waits for it.
    if (disposed) {
      await removeContainer(containerId).catch(() => undefined);
      throw disposedDuringStart(spec);
    }
    const stopLogStream = streamingEnabled ? streamLogs(containerId) : (): void => undefined;
    let ready: boolean;
    let wakeOnDispose: (() => void) | undefined;
    try {
      // `dispose()` does not wait out RIE's 30s readiness bound.
      ready = await Promise.race([
        waitForRieReady(spec.containerHost, hostPort, 30_000).then(() => true),
        new Promise<false>((resolve) => {
          wakeOnDispose = () => resolve(false);
          disposeWaiters.add(wakeOnDispose);
        }),
      ]);
    } catch (err) {
      // RIE didn't start — clean up before propagating.
      if (wakeOnDispose) disposeWaiters.delete(wakeOnDispose);
      stopLogStream();
      await removeContainer(containerId).catch(() => undefined);
      throw err;
    }
    if (wakeOnDispose) disposeWaiters.delete(wakeOnDispose);
    if (!ready || disposed) {
      stopLogStream();
      await removeContainer(containerId).catch(() => undefined);
      throw disposedDuringStart(spec);
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

  /**
   * A `docker run` that FAILS once `dispose()` began may still have created its
   * container: a terminal ^C signals the `docker` CLI too, which can abort
   * `docker run -d` between create and start (issue #4495). Remove it by its
   * `--name`, unique to this start with high probability (the pid plus ~20
   * random bits), before the failure settles.
   */
  async function removedIfDisposedOnFailure(name: string, run: Promise<string>): Promise<string> {
    try {
      return await run;
    } catch (err) {
      if (disposed) await removeContainer(name).catch(() => undefined);
      throw err;
    }
  }

  function disposedDuringStart(spec: ContainerSpec): Error {
    return new Error(`Container pool disposed while ${spec.lambda.logicalId} was starting`);
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

  const pool: ContainerPool = {
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
          const name = `cdkd-local-${spec.lambda.logicalId}-${process.pid}-${Math.floor(
            Math.random() * 1_000_000
          )}`;
          const startPromise = startOne(spec, name);
          inFlightStarts.set(startPromise, name);
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

      // After dispose() started, never hand the handle off to a new
      // acquire() (the post-drain teardown is about to run). Push the
      // handle onto `warm` so dispose()'s post-drain harvest picks it
      // up for `removeContainer`. The idle GC timer is NOT re-armed
      // because dispose() has already cleared every entry's idleTimer
      // up front.
      if (disposed) {
        entry.warm.push(handle);
        if (entry.inUse.size === 0) {
          for (const resolve of entry.drainResolvers.splice(0, entry.drainResolvers.length)) {
            try {
              resolve();
            } catch {
              /* swallow */
            }
          }
        }
        return;
      }

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

      // If dispose() is waiting for this entry to drain, signal now.
      if (entry.inUse.size === 0 && entry.drainResolvers.length > 0) {
        for (const resolve of entry.drainResolvers.splice(0, entry.drainResolvers.length)) {
          try {
            resolve();
          } catch {
            /* swallow */
          }
        }
      }
    },

    dispose(): Promise<void> {
      // A second caller (the ^C after a `--watch` reload's background dispose
      // of this pool) waits for the first run to finish (issue #4495).
      disposeRun ??= disposeOnce();
      return disposeRun;
    },
  };

  /**
   * Wait for the cold-start `startOne` calls that were mid-flight at
   * dispose time (issue #4495). Each one stops at its next step once it
   * sees `disposed`, removing its own container; one that completed first
   * contributes its handle to the teardown set. A start still pending after
   * the bound (a hung `docker run`) has its container removed by `--name`
   * instead.
   */
  async function settleInFlightStarts(): Promise<ContainerHandle[]> {
    const settledHandles: ContainerHandle[] = [];
    const starts = [...inFlightStarts];
    if (starts.length > 0) {
      logger.info(
        `Waiting for ${starts.length} in-flight container start(s) so their containers can be removed...`
      );
      const wrapped = starts.map(([p, name]) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        return Promise.race([
          p.then((h): { kind: 'ok'; handle: ContainerHandle } => ({ kind: 'ok', handle: h })),
          new Promise<{ kind: 'timeout'; name: string }>((r) => {
            timer = setTimeout(() => r({ kind: 'timeout', name }), IN_FLIGHT_START_TIMEOUT_MS);
          }),
        ])
          .catch((err: unknown) => {
            // `startOne` rejected — it removed whatever it started.
            logger.debug(
              `In-flight startOne rejected during dispose: ${err instanceof Error ? err.message : String(err)}`
            );
            return { kind: 'rejected' as const };
          })
          .finally(() => clearTimeout(timer));
      });
      const results = await Promise.all(wrapped);
      const abandoned: string[] = [];
      for (const r of results) {
        if (r.kind === 'ok') {
          settledHandles.push(r.handle);
        } else if (r.kind === 'timeout') {
          abandoned.push(r.name);
        }
      }
      await Promise.allSettled(abandoned.map((name) => removeContainer(name)));
      for (const name of abandoned) {
        const shown = quotedOrDescribed(name, 'container name');
        const remedy = isPasteableIdent(name)
          ? `docker rm -f ${name}`
          : // The pool's names always start `cdkd-local-` (no `--cluster` prefix).
            'docker ps -a --filter name=cdkd-local-';
        // cdkd-raw-beside-safe: a constant number, and a remedy built only from a
        // name `isPasteableIdent` admitted or a fixed command.
        logger.warn(
          safeMsg`A container start was still pending after ${IN_FLIGHT_START_TIMEOUT_MS / 1000}s; removed container ${shown} if it existed, but a docker run that completes later can still start it -- run '${remedy}' if it appears.`
        );
      }
      inFlightStarts.clear();
    }
    return settledHandles;
  }

  async function disposeOnce(): Promise<void> {
    disposed = true;
    for (const wake of disposeWaiters) wake();
    disposeWaiters.clear();
    logger.debug('Disposing container pool');

    // Cancel idle timers and reject pending acquire-waiters up front;
    // those don't carry an in-flight request to wait on.
    for (const entry of entries.values()) {
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
      for (const waiter of entry.waitQueue.splice(0, entry.waitQueue.length)) {
        try {
          waiter.reject(new Error(`Container pool disposed while ${entry.logicalId} was waiting`));
        } catch {
          /* swallow */
        }
      }
    }

    // Started now, so its bound runs alongside the request drain below
    // rather than after it. No start begins after `disposed` is set.
    const startsSettled = settleInFlightStarts();

    // Wait for every in-flight handle to release before tearing down
    // the underlying container. A request mid-`invokeRie` that gets
    // its container killed surfaces as a 502 — exactly the leak the
    // PR review caught. Bounded by `drainTimeoutMs` so a hung
    // request can't block shutdown forever; the verify.sh
    // `docker rm -f cdkd-local-*` sweep is the safety net for the
    // timeout case.
    const drainTimeoutMs = 30_000;
    const drainStart = Date.now();
    const entryDrains: Array<Promise<{ entry: ContainerPoolEntry; timedOut: boolean }>> = [];
    for (const entry of entries.values()) {
      if (entry.inUse.size === 0) continue;
      entryDrains.push(
        new Promise<{ entry: ContainerPoolEntry; timedOut: boolean }>((resolveDrain) => {
          entry.drainResolvers.push(() => resolveDrain({ entry, timedOut: false }));
          const t = setTimeout(() => {
            resolveDrain({ entry, timedOut: true });
          }, drainTimeoutMs);
          t.unref?.();
        })
      );
    }
    if (entryDrains.length > 0) {
      logger.debug(
        `Waiting for ${entryDrains.length} entry/entries' in-flight handle(s) to drain before teardown`
      );
      const drainResults = await Promise.all(entryDrains);
      let anyTimedOut = false;
      for (const r of drainResults) {
        if (r.timedOut) {
          anyTimedOut = true;
          logger.warn(
            `Container pool dispose timed out waiting for ${r.entry.inUse.size} in-flight handle(s) on ${r.entry.logicalId} after ${drainTimeoutMs}ms; tearing down anyway. The verify.sh \`docker rm -f cdkd-local-*\` sweep is the safety net.`
          );
        }
      }
      if (!anyTimedOut) {
        logger.debug(`In-flight drain completed in ${Date.now() - drainStart}ms`);
      }
    }

    // Now harvest every handle the entry owns (warm + still-in-use
    // for the timed-out case) for teardown.
    const allHandles: ContainerHandle[] = [];
    for (const entry of entries.values()) {
      allHandles.push(...entry.warm.splice(0, entry.warm.length));
      for (const h of entry.inUse) allHandles.push(h);
      entry.inUse.clear();
    }

    allHandles.push(...(await startsSettled));

    // Tear down in parallel; `tearDown` swallows individual failures.
    await Promise.allSettled(allHandles.map((h) => tearDown(h)));
    entries.clear();
  }

  return pool;
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
