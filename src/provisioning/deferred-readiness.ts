import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * go-to-k/cdkd#6940: the readiness waits `--no-wait` skips, kept for the
 * deploy to run later if it turns out to need the resource.
 *
 * Under `--no-wait` a provider returns while its resource is still pending (a
 * NAT gateway `pending`, an RDS cluster `creating`). The deploy then waits for
 * that readiness only where it needs it: a `Fn::GetAtt` of an attribute that
 * exists only once the resource is ready, and a custom resource whose handler
 * runs while the resource is upstream of it. A plain dependent never waits.
 *
 * A provider opts in with ONE call at its skip site, handing over the wait it
 * would have run in the default mode:
 *
 * ```ts
 * if (process.env['CDKD_NO_WAIT'] === 'true') {
 *   deferReadiness(logicalId, resourceType, physicalId, (signal) => waitAvailable(signal));
 * } else {
 *   await waitAvailable(undefined);
 * }
 * ```
 *
 * where `waitAvailable` is the provider's own wait, passing `signal` to an SDK
 * waiter as its `abortSignal`.
 *
 * The engine binds a {@link DeferredReadinessScope} around each CREATE /
 * UPDATE it provisions and keeps what the provider reported only when that
 * operation succeeds. Outside a scope (a rollback replay, `cdkd destroy`,
 * `cdkd drift --revert`, a test calling the provider directly) the call does
 * nothing, so the skipped wait stays skipped exactly as before.
 *
 * Import-free LEAF: every provider may import it without pulling the engine
 * onto its startup path.
 */

/**
 * The skipped wait. It must resolve once the resource is ready, reject when
 * the resource ends failed (or the wait runs out), and stop polling once
 * `signal` aborts (an SDK waiter takes it as `abortSignal`). The engine bounds
 * it by the resource type's `--resource-timeout` and Ctrl-C.
 */
export type ReadinessWait = (signal: AbortSignal) => Promise<unknown>;

/**
 * One skipped wait, with the async context of the operation that skipped it
 * (`AsyncLocalStorage.snapshot()` at the {@link deferReadiness} call): the
 * wait later runs in THAT resource's context — its secret-masking and printing
 * bags — never in the context of whichever consumer happens to need it first.
 */
export interface DeferredReadinessEntry {
  readonly wait: ReadinessWait;
  readonly inContext: <R>(fn: () => R) => R;
  /** What the wait is for; words the line its first need prints. Absent: `skipped-wait`. */
  readonly kind?: ReadinessKind;
  /**
   * For a wait with a known end (an IAM settle): how long it still has left,
   * `0` once it would resolve at once. Absent: unknown.
   */
  readonly remainingMs?: () => number;
}

/** What {@link deferReadiness} records beside the wait. */
export interface DeferReadinessOptions {
  readonly kind?: ReadinessKind;
  readonly remainingMs?: () => number;
}

/**
 * Why a resource's readiness is deferred:
 *
 * - `skipped-wait`: a wait the provider skipped under `--no-wait`
 *   (go-to-k/cdkd#6940).
 * - `iam-propagation`: an IAM permission write that AWS has accepted but not
 *   yet propagated. Only code running during the deploy with that permission
 *   (a custom resource's handler) needs it settled; see
 *   `iam-propagation-settle.ts`.
 */
export type ReadinessKind = 'skipped-wait' | 'iam-propagation';

/**
 * Throw when the deploy aborted the wait (`signal`), for a provider's own
 * poll loop to call before each read and sleep. The engine has already
 * settled the wait by then; this only stops the polling.
 */
export function throwIfReadinessAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error('readiness wait aborted');
}

/**
 * Sleep `ms`, ending early (by throwing) once `signal` aborts. For a provider
 * poll loop whose wait the deploy may abort. With a signal, the sleep is its
 * own timer, cleared on abort so nothing outlives the wait; without one it is
 * the provider's `sleep` (its test seam) unchanged.
 */
export function abortableSleep(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined
): Promise<void> {
  if (signal === undefined) return sleep(ms);
  throwIfReadinessAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('readiness wait aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The engine's half: what the operation it provisions may defer. */
export interface DeferredReadinessScope {
  readonly logicalId: string;
  readonly resourceType: string;
  /** Keyed by physical id: a retry re-reporting the same resource replaces its wait. */
  readonly deferred: Map<string, DeferredReadinessEntry>;
  /**
   * Wait for every resource upstream of this one whose readiness wait the
   * deploy skipped (go-to-k/cdkd#6940). Read by a provider that runs code
   * during the deploy: the custom-resource provider, right before it invokes
   * the handler. Resolves at once when nothing upstream was deferred.
   */
  readonly awaitUpstreamReadiness: () => Promise<void>;
  /**
   * The same waits, rejecting with the raw cause: what a nested stack's child
   * scope chains to on its parent row's scope, and re-anchors on its own
   * resource.
   */
  readonly awaitUpstreamReadinessRaw: () => Promise<void>;
  /**
   * The deferred readiness of the resource of THIS deploy whose physical id is
   * `physicalId`, or `undefined` when its wait was not skipped (rule 3 of
   * go-to-k/cdkd#6940: a call AWS refuses while that resource is not ready,
   * such as associating an Elastic IP with a `pending` instance).
   */
  readonly awaitDeferredResource: (physicalId: string, reason: string) => Promise<void> | undefined;
}

const storage = new AsyncLocalStorage<DeferredReadinessScope>();

/** Run `fn` with `scope` bound. An inner scope replaces an outer one (a nested stack's child). */
export function withDeferredReadinessScope<T>(
  scope: DeferredReadinessScope,
  fn: () => Promise<T>
): Promise<T> {
  return storage.run(scope, fn);
}

function anchoredScope(
  logicalId: string,
  resourceType: string
): DeferredReadinessScope | undefined {
  const scope = storage.getStore();
  return scope !== undefined && scope.logicalId === logicalId && scope.resourceType === resourceType
    ? scope
    : undefined;
}

/**
 * Report a readiness wait the provider skipped under `--no-wait` (or, with
 * `options.kind`, another readiness the deploy runs only where it is needed). Anchored
 * to the operation the engine bound: a call for another logical id or type (a
 * helper provisioning something else) reports nothing.
 */
export function deferReadiness(
  logicalId: string,
  resourceType: string,
  physicalId: string,
  wait: ReadinessWait,
  options: DeferReadinessOptions = {}
): void {
  if (typeof physicalId !== 'string' || physicalId === '') return;
  const scope = anchoredScope(logicalId, resourceType);
  if (scope === undefined) return;
  scope.deferred.set(physicalId, {
    wait,
    inContext: AsyncLocalStorage.snapshot(),
    kind: options.kind ?? 'skipped-wait',
    ...(options.remainingMs !== undefined && { remainingMs: options.remainingMs }),
  });
}

/**
 * The deferred readiness of the resource of this deploy whose physical id is
 * `physicalId`, for a provider whose own call AWS refuses until it is ready
 * (rule 3). `undefined` outside a deploy, or when that wait was not skipped.
 */
export function awaitDeferredResource(
  logicalId: string,
  resourceType: string,
  physicalId: string,
  reason: string
): Promise<void> | undefined {
  return anchoredScope(logicalId, resourceType)?.awaitDeferredResource(physicalId, reason);
}

/** The scope bound around the current operation, if any (a nested stack's child reads its parent's row). */
export function currentDeferredReadinessScope(): DeferredReadinessScope | undefined {
  return storage.getStore();
}

/**
 * Before running code that can reach what is upstream of `logicalId`, wait
 * for each upstream resource whose readiness the deploy skipped. Nothing to do
 * outside an engine scope, or inside one bound for another logical id.
 * Anchored by logical id alone: a custom resource's type is its own name.
 */
export function awaitUpstreamReadiness(logicalId: string): Promise<void> {
  const scope = storage.getStore();
  return scope !== undefined && scope.logicalId === logicalId
    ? scope.awaitUpstreamReadiness()
    : Promise.resolve();
}
