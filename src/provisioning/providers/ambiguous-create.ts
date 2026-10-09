/**
 * Bookkeeping for a provider CREATE whose API carries NO idempotency token
 * (issue [#2080](https://github.com/go-to-k/cdkd/issues/2080), Plan C:
 * `CreateKey`, `CreateUserPool`, `CreateGraphqlApi`).
 *
 * The deploy engine re-invokes `create()` from the top on a retryable error,
 * and an HTTP 5xx is retryable (issue #2026). When the 5xx hid a request AWS
 * actually completed, the replay mints a SECOND resource and the first is in
 * no state record. `idempotency-token.ts` closes that for APIs with a token
 * member; these three have none, so the provider can only find out after the
 * fact, on the NEXT attempt, by looking -- and, lacking any exact attribution,
 * only REPORT what it finds (see `docs/provider-rules.md`).
 *
 * Three pieces live here, process-scoped like the token memo:
 *
 *  - {@link withoutServerErrorRetries} stops the AWS SDK's OWN retry of a 5xx
 *    on the create client, so every 5xx reaches the engine's retry and this
 *    latch instead of being replayed invisibly inside one `send`.
 *  - {@link AmbiguousCreateLatch} remembers that an attempt at one logical
 *    create ended AMBIGUOUS (`isAmbiguousOutcomeError`) and the window it ran
 *    in. Only then does the next attempt pay for a lookup. A failure AWS
 *    declared as "nothing happened" (a 4xx, a throttle, IAM propagation's `not
 *    authorized`) never arms it, so the common retry costs nothing extra.
 *  - {@link RecentIdSet} remembers the ids this process created SUCCESSFULLY,
 *    so a lookup never offers back a resource an earlier deploy in the same
 *    long-lived process (the local dev loop) already recorded.
 *
 * The latch is keyed like the token memo: `(scope, region, stackName,
 * logicalId)`, encoded with `injectiveKey`, because that tuple is what the
 * retry loop reproduces byte-for-byte and what identifies a resource in cdkd's
 * state layout.
 */

import { getCurrentStackName } from '../resource-name.js';
import { injectiveKey } from '../../state/record-keys.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import {
  hasReplayMayCollide,
  isAmbiguousOutcomeError,
  isTransientServerError,
  markReplayMayCollide,
} from '../../deployment/retryable-errors.js';

/**
 * Tolerance between our clock (the attempt start) and the service's (a
 * resource's `CreationDate`). Same margin and same reasoning as
 * `iam-access-key-provider.ts`: without one, ordinary skew hides the very
 * resource the lookup is for; the residual it admits is bounded by one
 * create call plus this margin.
 */
export const CREATION_DATE_SKEW_MARGIN_MS = 5_000;

/**
 * How long an armed latch (and `KMSProvider`'s held keys) stays usable. A
 * latch armed by the LAST attempt of a create that then gave up is never taken
 * by that create, so without an age limit a long-lived process (the local dev
 * loop, a library caller) would hand a much later create of the same logical
 * id a window from a deploy that is long over.
 */
export const AMBIGUOUS_LATCH_TTL_MS = 30 * 60_000;

/** Ceiling on each process-scoped map, so a long-lived process cannot grow it without bound. */
const MAX_TRACKED = 10_000;

/**
 * The identity of one logical create for a process-scoped memo: `(scope,
 * region, stackName, logicalId)`. Exported for a provider that keeps its own
 * per-create memo beside the latch (`KMSProvider`'s resumable keys).
 */
export const createAttemptKey = (scope: string, logicalId: string): string =>
  injectiveKey(scope, ambientRegion() ?? '', getCurrentStackName() ?? '', logicalId);

/** `map.set`, evicting the oldest entry once {@link MAX_TRACKED} is reached. */
export const setBounded = <V>(map: Map<string, V>, key: string, value: V): void => {
  if (!map.has(key) && map.size >= MAX_TRACKED) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
};

/** The window an ambiguous create attempt could have minted its resource in, skew-widened. */
export interface AmbiguousCreateWindow {
  /** Earliest ambiguous attempt start, minus {@link CREATION_DATE_SKEW_MARGIN_MS}. */
  readonly floorMs: number;
  /**
   * Latest ambiguous attempt end, plus {@link CREATION_DATE_SKEW_MARGIN_MS}.
   * The end is where the CLIENT gave up. For a 5xx the service had already
   * answered, so its resource is older than that; for a client timeout or a
   * reset the service may finish later than the margin allows, and that
   * resource falls outside the window -- missed (a duplicate, reported by
   * nobody), never wrongly attributed. Only the SDK replays those, inside the
   * same `send` ({@link withoutServerErrorRetries} stamps it), so the end
   * already follows its last attempt; the engine replays none
   * (`src/deployment/retry.ts`), and should it start to, revisit this bound.
   */
  readonly ceilingMs: number;
  /**
   * `true` when the window is not an earlier failed attempt's but the
   * SUCCESSFUL create's own, whose `send` the AWS SDK replayed
   * ({@link replayedSendWindow}): the lookup runs after the create, and the
   * resource it returned is already recorded. Only changes the report's wording.
   */
  readonly replayedInSend?: true;
}

/**
 * `true` when the SDK replayed the request inside the `send` that produced
 * `output` (issue #4687). The retry middleware stamps every successful output
 * with `$metadata.attempts`, so more than one attempt means an earlier attempt
 * failed and was sent again -- and when that earlier attempt reached the
 * service (a socket reset or timeout after the request was sent; a 5xx is
 * refused by {@link withoutServerErrorRetries}), a create with no idempotency
 * token and no unique name has now made TWO resources, of which the output
 * names only the second. A replay after a throttle or a refused connection
 * reads `true` as well, so the report-only lookup it feeds runs then too. For a
 * type with a creation date that lookup finds nothing; for an undated type it
 * can name an unrelated resource of the same name (the warning already says it
 * may be another stack's). A caller that DELETES on this signal reads
 * {@link replayFollowedAmbiguousAttempt} instead.
 */
export const replayedInSend = (output: unknown): boolean => {
  const attempts = (output as { $metadata?: { attempts?: unknown } } | undefined)?.$metadata
    ?.attempts;
  return typeof attempts === 'number' && attempts > 1;
};

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

/**
 * The finalize-step `args` of each `send` on a {@link withoutServerErrorRetries}
 * client that has had an AMBIGUOUS attempt. The SDK's retry middleware hands
 * the SAME `args` object to every attempt of one `send` and builds a new one
 * for every `send`, so this is per-send state, never shared by two sends.
 */
const sendsAfterAmbiguous = new WeakSet<object>();

/** The outputs {@link replayFollowedAmbiguousAttempt} reads `true` for. */
const outputsAfterAmbiguous = new WeakSet<object>();

/**
 * Record that the successful `send` producing `output` replayed an attempt that
 * ended AMBIGUOUS. Called by {@link withoutServerErrorRetries}'s middleware; a
 * unit test that stubs `send` calls it to model such an output.
 */
export const markReplayFollowedAmbiguous = (output: unknown): void => {
  if (isObject(output)) outputsAfterAmbiguous.add(output);
};

/**
 * `true` only when the successful `send` that produced `output` replayed an
 * attempt that ended AMBIGUOUS (`isAmbiguousOutcomeError`: a socket reset or
 * timeout that may have reached the service) -- the narrow form of
 * {@link replayedInSend}, which also reads `true` after a throttle or a refused
 * connection the SDK retried, where the service did nothing. Only a
 * {@link withoutServerErrorRetries} client records it. Read this before
 * DELETING anything on the replay signal (`IAMAccessKeyProvider`): every extra
 * reconcile widens the window in which another process's fresh resource could
 * pass its checks. Keyed on the output object itself, so two concurrent sends
 * on one client cannot read each other's answer.
 */
export const replayFollowedAmbiguousAttempt = (output: unknown): boolean =>
  isObject(output) && outputsAfterAmbiguous.has(output);

/** The part of Smithy's `MiddlewareStack` {@link withoutServerErrorRetries} needs. */
interface MiddlewareStackLike {
  addRelativeTo(
    middleware: (
      next: (args: object) => Promise<{ output?: unknown }>
    ) => (args: object) => Promise<{ output?: unknown }>,
    options: { name: string; relation: 'after'; toMiddleware: string; override: boolean }
  ): void;
}

/**
 * Sits directly inside the SDK's retry middleware, so it runs once per ATTEMPT
 * and sees each attempt's raw error -- the object the retry strategy classifies.
 */
const AMBIGUOUS_REPLAY_MIDDLEWARE = 'cdkdAmbiguousReplayMiddleware';

const trackAmbiguousReplays = (client: object): void => {
  const stack = (client as { middlewareStack?: Partial<MiddlewareStackLike> }).middlewareStack;
  if (typeof stack?.addRelativeTo !== 'function') return;
  (stack as MiddlewareStackLike).addRelativeTo(
    (next) => async (args) => {
      try {
        const result = await next(args);
        if (sendsAfterAmbiguous.has(args)) markReplayFollowedAmbiguous(result.output);
        return result;
      } catch (error) {
        if (isAmbiguousOutcomeError(error)) sendsAfterAmbiguous.add(args);
        throw error;
      }
    },
    {
      name: AMBIGUOUS_REPLAY_MIDDLEWARE,
      relation: 'after',
      toMiddleware: 'retryMiddleware',
      override: true,
    }
  );
};

/**
 * The window to look for the duplicate of a create that SUCCEEDED after a
 * {@link replayedInSend} replay, or `undefined` when the `send` made a single
 * attempt -- the common case, which pays for no lookup. Call it right after the
 * create's `send` returns: the duplicate, if any, was minted between
 * `attemptStartMs` and now. The lookup it feeds must exclude the id the output
 * returned: pass it as an explicit exclusion when the provider adds it to its
 * {@link RecentIdSet} only after follow-up calls that can fail (a resource left
 * behind by a failed rollback must stay nameable by a later lookup).
 */
export const replayedSendWindow = (
  output: unknown,
  attemptStartMs: number
): AmbiguousCreateWindow | undefined =>
  replayedInSend(output)
    ? {
        floorMs: attemptStartMs - CREATION_DATE_SKEW_MARGIN_MS,
        ceilingMs: Date.now() + CREATION_DATE_SKEW_MARGIN_MS,
        replayedInSend: true,
      }
    : undefined;

/**
 * The opening of an orphan report: what made the create's outcome ambiguous.
 * `action` is the create call, e.g. `CreateKey`.
 */
export const ambiguousAttemptLead = (
  action: string,
  logicalId: string,
  window: AmbiguousCreateWindow
): string =>
  window.replayedInSend === true
    ? `The ${action} call for ${logicalId} succeeded only after the AWS SDK sent it again, following an attempt that failed without a definite answer`
    : `An earlier ${action} attempt for ${logicalId} failed without a definite answer`;

interface LatchEntry extends AmbiguousCreateWindow {
  readonly armedAtMs: number;
}

const mergeWindow = (
  existing: LatchEntry | undefined,
  next: AmbiguousCreateWindow,
  armedAtMs: number
): LatchEntry =>
  existing === undefined
    ? { floorMs: next.floorMs, ceilingMs: next.ceilingMs, armedAtMs }
    : {
        floorMs: Math.min(existing.floorMs, next.floorMs),
        ceilingMs: Math.max(existing.ceilingMs, next.ceilingMs),
        armedAtMs: Math.max(existing.armedAtMs, armedAtMs),
      };

/**
 * "An earlier attempt at this create may have succeeded without our knowing."
 */
export class AmbiguousCreateLatch {
  private readonly entries = new Map<string, LatchEntry>();

  private readonly scope: string;

  /** @param scope the AWS action name, e.g. `'CreateKey'`. */
  constructor(scope: string) {
    this.scope = scope;
  }

  /**
   * Arm the latch when `error` -- thrown by the CREATE call itself, never by
   * a follow-up call on a resource whose id is already known -- leaves the
   * outcome ambiguous. Call it from the create call's own `catch`, so "now" is
   * the attempt's END: the resource, if any, was minted between
   * `attemptStartMs` and now.
   *
   * `carried` is the window this attempt {@link take}s before creating. The
   * providers take the latch BEFORE the create, so without it a second
   * ambiguous attempt in a row would record only its own window and the next
   * lookup would no longer cover the first attempt's orphan. It is merged in
   * only when THIS attempt is ambiguous too: after a definite failure or a
   * success the earlier orphans were already reported by this attempt's
   * lookup.
   */
  noteFailure(
    logicalId: string,
    error: unknown,
    attemptStartMs: number,
    carried?: AmbiguousCreateWindow
  ): void {
    // The stamp: an ambiguous attempt the SDK replayed inside the same `send`,
    // ending in a definite error (a throttle, say) the predicate alone clears.
    if (!isAmbiguousOutcomeError(error) && !hasReplayMayCollide(error)) return;
    const key = createAttemptKey(this.scope, logicalId);
    const now = Date.now();
    let entry = mergeWindow(
      this.entries.get(key),
      {
        floorMs: attemptStartMs - CREATION_DATE_SKEW_MARGIN_MS,
        ceilingMs: now + CREATION_DATE_SKEW_MARGIN_MS,
      },
      now
    );
    if (carried !== undefined) entry = mergeWindow(entry, carried, now);
    setBounded(this.entries, key, entry);
  }

  /**
   * Read AND clear the latch: the window to look in, or `undefined` when no
   * earlier attempt ended ambiguous (or the latch is older than
   * {@link AMBIGUOUS_LATCH_TTL_MS}). Cleared on read so one ambiguous failure is
   * looked up (and reported) once; a later ambiguous attempt re-arms it.
   */
  take(logicalId: string): AmbiguousCreateWindow | undefined {
    const key = createAttemptKey(this.scope, logicalId);
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (entry === undefined || Date.now() - entry.armedAtMs > AMBIGUOUS_LATCH_TTL_MS) {
      return undefined;
    }
    return { floorMs: entry.floorMs, ceilingMs: entry.ceilingMs };
  }

  /** TEST-ONLY. */
  resetForTests(): void {
    this.entries.clear();
  }
}

/** `true` when `date` falls inside `window` (both ends inclusive). */
export const isInsideWindow = (date: Date | undefined, window: AmbiguousCreateWindow): boolean =>
  date !== undefined && date.getTime() >= window.floorMs && date.getTime() <= window.ceilingMs;

/** Ids this process created successfully, bounded. */
export class RecentIdSet {
  private readonly ids = new Map<string, true>();

  add(id: string): void {
    setBounded(this.ids, id, true);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** TEST-ONLY. */
  resetForTests(): void {
    this.ids.clear();
  }
}

/** The part of Smithy's `RetryStrategyV2` this module needs; `@smithy/types` is not a direct dependency. */
interface RetryStrategyV2Like {
  acquireInitialRetryToken(scope: string): Promise<unknown>;
  refreshRetryTokenForRetry(token: unknown, errorInfo: { error?: unknown }): Promise<unknown>;
  recordSuccess(token: unknown): void;
}

const isRetryStrategyV2 = (value: unknown): value is RetryStrategyV2Like =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as RetryStrategyV2Like).acquireInitialRetryToken === 'function' &&
  typeof (value as RetryStrategyV2Like).refreshRetryTokenForRetry === 'function' &&
  typeof (value as RetryStrategyV2Like).recordSuccess === 'function';

/**
 * Stop the AWS SDK retrying a 5xx on `client`, IN PLACE, and return it (issue
 * #2080; the SDK-internal half of #3978 layer (b)).
 *
 * The SDK's standard strategy retries a 500 / 502 / 503 / 504 up to twice
 * inside one `send`. For a create with no idempotency token that replay is
 * the duplicate this module exists to report -- except that it happens where
 * neither the engine nor {@link AmbiguousCreateLatch} can see it, so the first
 * resource is orphaned SILENTLY. Refused here, the 5xx surfaces to the
 * provider, arms the latch, and reaches the engine's own retry, whose default
 * classifier retries a 5xx (and a throttle) on a longer schedule than the SDK
 * would. Everything else keeps the SDK's retry: a throttle IDENTIFIED as one
 * (by its error name or the SDK's `$retryable.throttling` flag -- the service
 * did nothing), a connection that never opened, a clock-skew correction, and a
 * socket reset or timeout -- the last two are ambiguous too, but the engine
 * does NOT retry them, so refusing them here would turn a flaky network into
 * a failed deploy instead of a (rare) duplicate.
 *
 * What the SDK replays after an AMBIGUOUS attempt (`isAmbiguousOutcomeError`,
 * the predicate the engine's latch reads, so the two agree) is stamped
 * instead: every later attempt's error in the same `send` carries
 * `markReplayMayCollide`, so a name-unique create whose reset request DID
 * succeed throws an "already exists" the engine reads as this create's own
 * replay, not another holder's name (issue #4639), and
 * {@link AmbiguousCreateLatch} arms on that stamp too. The predicate errs
 * toward TRUE, so a reset on a stale pooled socket or a connect timeout,
 * neither of which reached the service, stamps as well: a genuine collision
 * then fails instead of being deleted first, the safe direction. A replay
 * that SUCCEEDS after such an attempt makes a second resource when the create
 * is not name-unique; the provider finds out from {@link replayedInSend} and
 * runs its orphan lookup after the create (issue #4687). A middleware placed
 * directly inside the retry middleware also records, per `send`, whether a
 * successful output followed an ambiguous attempt
 * ({@link replayFollowedAmbiguousAttempt}), for a caller that must not act on a
 * throttle's replay.
 *
 * Works by wrapping the client's RESOLVED `config.retryStrategy` provider,
 * which the SDK's retry middleware re-reads on every `send`; a unit test runs
 * a real client against a stub HTTP handler to pin that. A client whose
 * strategy is not the V2 shape (never the case for the pinned SDK) is left
 * unchanged rather than half-wrapped.
 *
 * Use a DEDICATED client for the create call: every other call on the
 * provider keeps the full SDK retry.
 */
export function withoutServerErrorRetries<T extends object>(client: T): T {
  const config = (client as { config?: { retryStrategy?: unknown } }).config;
  const base = config?.retryStrategy;
  if (config === undefined || typeof base !== 'function') return client;
  trackAmbiguousReplays(client);
  const resolveBase = base as () => Promise<unknown>;
  // The retry tokens of a `send` that already had an ambiguous attempt. The
  // middleware calls `refreshRetryTokenForRetry` on EVERY failed attempt, the
  // last one included, and rethrows that attempt's error object when it
  // rejects -- so stamping `errorInfo.error` here stamps what `send` throws.
  const afterAmbiguous = new WeakSet<object>();
  config.retryStrategy = async (): Promise<unknown> => {
    const strategy = await resolveBase();
    if (!isRetryStrategyV2(strategy)) return strategy;
    const wrapped: RetryStrategyV2Like = {
      acquireInitialRetryToken: (scope) => strategy.acquireInitialRetryToken(scope),
      refreshRetryTokenForRetry: async (token, errorInfo) => {
        const ambiguous = isAmbiguousOutcomeError(errorInfo.error);
        const replayed = isObject(token) && afterAmbiguous.has(token);
        // Never throws, and leaves a non-extensible error as it is.
        if (replayed) markReplayMayCollide(errorInfo.error);
        // Throwing refuses the retry: the middleware then rethrows the
        // ORIGINAL error, unchanged.
        // `isAmbiguousOutcomeError`, not `!isThrottlingError`: the latter
        // counts EVERY 429 / 503 as a throttle by status alone, which would
        // leave a plain 503 (`ServiceUnavailableException`, KMS's documented
        // `DependencyTimeoutException`) to the SDK's silent replay. The
        // ambiguity check exempts only a throttle named as one.
        if (ambiguous && isTransientServerError(errorInfo.error)) {
          throw new Error('cdkd: no SDK retry of a 5xx on a tokenless create');
        }
        const next = await strategy.refreshRetryTokenForRetry(token, errorInfo);
        if ((ambiguous || replayed) && isObject(next)) afterAmbiguous.add(next);
        return next;
      },
      recordSuccess: (token) => strategy.recordSuccess(token),
    };
    return wrapped;
  };
  return client;
}
