/**
 * The lock manager's module-level constants, types and render helpers.
 *
 * Moved verbatim out of `src/state/lock-manager.ts` (go-to-k/cdkd#5835), which
 * re-exports the ones it always exported.
 */
import type { LockInfo } from '../../types/state.js';
import { displayIdent, displaySafe, STACK_REF_MAX_CODE_POINTS } from '../../utils/display-safe.js';
import { UNRENDERABLE } from '../lock-contention-message.js';

/**
 * Upper bound on the gap between lock renewals.
 *
 * Deliberately a fixed wall-clock ceiling rather than a pure fraction of the
 * TTL. A fraction alone (TTL/4 = 7.5 min at the default) makes renewal
 * unobservable in any deploy shorter than that, so nothing short of a
 * multi-hour fixture could ever prove the loop runs -- and an untestable
 * heartbeat is one that goes dead silently. At 2 min the default 30 min TTL
 * tolerates FOURTEEN consecutive missed renewals before it lapses, and an
 * ordinary broad-set integ (~8 min) performs three.
 */
const MAX_RENEWAL_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Renew after at most a quarter of the TTL, so a short TTL still gets three
 * chances to renew before it lapses. This is what binds the two numbers
 * together for a caller that shortens `ttlMinutes`.
 */
const RENEWAL_TTL_FRACTION = 4;

/** Floor, so a pathologically small TTL cannot spin the event loop. */
const MIN_RENEWAL_INTERVAL_MS = 1000;

/** How often a lock of `ttlMs` is renewed. */
export function renewalIntervalFor(ttlMs: number): number {
  return Math.max(
    MIN_RENEWAL_INTERVAL_MS,
    Math.min(MAX_RENEWAL_INTERVAL_MS, Math.floor(ttlMs / RENEWAL_TTL_FRACTION))
  );
}

/**
 * go-to-k/cdkd#4705 review B1: the latest moment an abandoned run can have
 * been alive while its lock was renewed -- a run whose renewals kept failing
 * may have outlived it, and what it created after it is refused (the
 * `cdkd import` remedy), never adopted -- read off the lock it left: its last
 * renewal (the object's
 * LastModified, S3's clock) plus that lock's renewal interval -- the run kept
 * creating between renewals. The interval comes from the lock's own TTL
 * (`expiresAt` minus the renewal that set it), with the manager's formula; a
 * lock that does not say falls back to the longest interval. `undefined` when
 * S3 reported no LastModified.
 */
export function abandonedRunHorizon(record: {
  info: { expiresAt?: unknown };
  lastModified?: number;
}): number | undefined {
  if (record.lastModified === undefined) return undefined;
  const expiresAt = Number(record.info.expiresAt);
  const ttlMs = expiresAt - record.lastModified;
  const interval =
    Number.isFinite(ttlMs) && ttlMs > 0 ? renewalIntervalFor(ttlMs) : MAX_RENEWAL_INTERVAL_MS;
  return record.lastModified + interval;
}

/**
 * How many times one `acquireLockWithRetry` call re-attempts at once, without
 * spending a retry, after a failed acquire is followed by an empty lock read
 * (issue #4055). The bound is what keeps a flapping lock -- or a lock.json
 * that reads as absent but is never replaceable -- from looping forever.
 */
export const RELEASED_LOCK_REACQUIRE_LIMIT = 3;

/**
 * Which kind of path landed the delete marker the purge is cleaning up after
 * (issue [#2346](https://github.com/go-to-k/cdkd/issues/2346) site 5).
 *
 * It exists to pick the LOG LEVEL, and the level is the one place where site 5
 * genuinely differs from the four sites already purging. It is spelled as the
 * PATH rather than as the level so the mapping — and its reason — lives in one
 * place instead of at each call site.
 *
 * - `'release'` — `releaseLock`, i.e. the tail of every mutating cdkd command.
 * - `'reap'` — `acquireLock`'s expired-lock takeover and `forceReleaseLock`
 *   (`cdkd force-unlock`, and `cdkd state orphan`). Rare, operator-visible.
 */
export type LockPurgePath = 'release' | 'reap';

/**
 * What a surviving `lock.json` version holds, for the purge warning's
 * parenthetical.
 *
 * The helper makes this per-caller precisely so a reader chasing the warning is
 * told which object to go and inspect; `lock.json` is the one call site whose
 * content is NOT a secret, and saying so is more useful than a vague phrase.
 */
export const LOCK_OBJECT_DESCRIPTION =
  'a stack lock heartbeat, which records the lock owner, its acquisition ' +
  'timestamp, its deadline and the operation name — no secret, but one row ' +
  'per renewal';

/**
 * A lock this process currently believes it holds.
 *
 * `etag` is the S3 ETag of the lock object as this process last wrote it, and
 * it is what makes both renewal and release CONDITIONAL: every subsequent
 * write carries `IfMatch: etag`, so a process that has already lost the lock
 * can neither resurrect its own expiry nor delete the new owner's lock.
 */
export interface HeldLock {
  stackName: string;
  region: string;
  key: string;
  info: LockInfo;
  etag: string | undefined;
  timer: NodeJS.Timeout | undefined;
  /**
   * The renewal currently in flight, if any.
   *
   * `releaseLock` awaits it before reading `etag`. Without that, a renewal
   * that lands between `stopRenewal()` and the DELETE leaves the caller
   * holding the PREVIOUS ETag, S3 answers 412, and this process refuses to
   * release its OWN lock -- stranding it for a full TTL behind a warning that
   * blames a process that does not exist.
   */
  renewing: Promise<void> | undefined;
  /** Set once S3 has told us the object is no longer the one we wrote. */
  lost: boolean;
  /**
   * The release in flight, or the settled result of the one that already ran.
   *
   * A PROMISE rather than a boolean, claimed SYNCHRONOUSLY, because both
   * failure modes matter. Claimed late (after an `await`) it does not close
   * the race it exists for: the force-quit paths in `destroy-runner` fire an
   * un-awaited `void releaseLock(...)` while the main `finally` may be
   * mid-release, and a boolean set after the awaits lets both through. And a
   * boolean set BEFORE the delete records a FAILED release as done, so a later
   * caller returns success having deleted nothing. Returning the same promise
   * gives the second caller the first one's actual outcome.
   */
  releasing: Promise<void> | undefined;
  /**
   * Set when `etag` is no longer known to match the stored object.
   *
   * Only the no-ETag renewal path sets it. It exists so the eventual 412 is
   * reported truthfully -- without it the release blames "another cdkd
   * process" for a conflict with this process's OWN write.
   */
  etagUncertain: boolean;
  /** Whether the "renewals are failing past the deadline" warning already fired. */
  warnedPastExpiry: boolean;
}

/**
 * One spelling of "this value came from an S3 key or a lock record, and is
 * about to be interpolated into a message a terminal will render". A stack
 * name and an AWS region both have a known charset, so the ASCII allowlist is
 * a no-op on every legitimate input while an S3 key admits any UTF-8.
 *
 * Call it for a stack name or a region. Not every value in this file goes
 * through it, and this comment does not say which do: three revisions of that
 * sentence carried a count or a scope claim and each was wrong.
 * `grep safeSegment` answers it exactly.
 */
export function safeSegment(value: string | undefined): string {
  // `displayIdent` IS the allowlist-plus-floor this used to spell, and adds a
  // boundary: bare when plain, otherwise one JSON string, so a call site writes
  // NO quotes of its own around it (go-to-k/cdkd#3617). The stack cap, since a
  // nested `Parent~Child` name legitimately runs past the 255 default.
  return displayIdent(value, { maxCodePoints: STACK_REF_MAX_CODE_POINTS });
}

/**
 * The `stack (region)` descriptor every lock message renders, with both halves
 * through {@link safeSegment}. A stack name reaches this module from a CLI
 * argument, a nested-stack child's minted name, or an S3 key segment
 * `listStacks` returned (`cdkd state destroy`, `cdkd state orphan`), and the
 * lock paths cannot tell which -- so every render takes the guard rather than
 * a per-caller judgement that the next caller would not inherit (issue #3027).
 */
export function stackRef(stackName: string, region: string | undefined): string {
  return region === undefined
    ? safeSegment(stackName)
    : `${safeSegment(stackName)} (${safeSegment(region)})`;
}

/**
 * An error's text for a lock message. S3's error text ECHOES the key, which
 * embeds the stack name, so a message whose stack name went through
 * {@link stackRef} would otherwise let the same bytes back in through its last
 * interpolation. The ASCII allowlist, for the same reason the name takes it.
 */
export function errorDetail(error: unknown): string {
  return (
    displaySafe(error instanceof Error ? error.message : error, { asciiOnly: true }) || UNRENDERABLE
  );
}

/**
 * Whether a lock has EXPIRED, by its `expiresAt` field — the one predicate the
 * lock manager acquires by, exported so a reader deciding "is a live lock held"
 * (issue #3754's nested-record judgement in `cdkd rollback`) cannot diverge.
 *
 * `expiresAt` reaches here through an unvalidated `as LockInfo`, so anyone who
 * can write the state bucket chooses it. `undefined`, `'soon'`, `NaN` and
 * `Infinity` all make a naive `Date.now() >= x` false FOREVER, which pins the
 * stack: no acquire ever succeeds and only `force-unlock` clears it. Treating a
 * non-finite deadline as already expired is the recoverable direction and
 * grants no new power -- someone who can write that value could equally have
 * deleted the object.
 */
export function isLockInfoExpired(lockInfo: LockInfo): boolean {
  if (!Number.isFinite(lockInfo.expiresAt)) return true;
  return Date.now() >= lockInfo.expiresAt;
}
