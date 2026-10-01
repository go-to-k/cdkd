import type { LockManager } from '../../state/lock-manager.js';
import {
  buildLockContentionMessage,
  forceQuitRecoveryClause,
  type LockRecoveryContext,
} from '../../state/lock-contention-message.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { getLogger } from '../../utils/logger.js';
import { safeMsg } from '../../utils/display-safe.js';

/**
 * The stack lock plus the SIGINT handler that guards it, as ONE unit.
 *
 * `destroy-runner.ts` takes the lock in two places (the main destroy and the
 * 0-resource state cleanup), and both owe the same contract; it used to be
 * written out twice and the second copy got three of its five rules wrong in
 * review (go-to-k/cdkd#2174). The rules, all owned here:
 *
 * 1. The handler is registered BEFORE the acquire (issue #1348): a signal
 *    landing in the acquire's S3 round-trip would otherwise hit the default
 *    disposition and strand the just-written lock for its full TTL.
 * 2. TWO signals: the first records the interrupt (the caller drains), the
 *    second force-quits with `process.exit(130)`. Force-quitting on the FIRST
 *    is a regression, not impatience: in a nested-stack destroy the PARENT's
 *    listener fires first and merely sets its drain flag, so a child that
 *    exits there skips the parent's `finally` and strands the PARENT's lock.
 * 3. The force-quit's best-effort release fires only while `lockHeld`: before
 *    the acquire resolves the key may belong to ANOTHER process, and
 *    `releaseLock` deletes unconditionally.
 * 4. The listener is removed on EVERY exit — the contention `false`, the
 *    acquire THROW (an S3 5xx; a leaked handler pre-empts every later drain in
 *    the process), and the release.
 * 5. RELEASE before UNREGISTER, so a Ctrl-C landing in the release round-trip
 *    is still answered by this handler, with the region-qualified recovery
 *    command, rather than by `watchCommandInterrupt`'s hedged fallback.
 *
 * Per-site work enters through hooks rather than by owning the handler: the
 * main destroy routes its notice through the live renderer, and its release
 * first stops that renderer and drains the incremental-state chain.
 */
export interface StackLockOptions {
  lockManager: Pick<LockManager, 'acquireLock' | 'releaseLock' | 'getLockInfo'>;
  stackName: string;
  region: string;
  /** Recorded in the lock body (`cdkd force-unlock` and contention messages show it). */
  operation: string;
  recovery: LockRecoveryContext;
  /**
   * The FIRST signal's user-facing notice. Called after the interrupt is
   * recorded; a throw is swallowed, because a throw inside a SIGINT listener is
   * uncaught and would kill the process holding the lock.
   */
  onFirstSignal: () => void;
  /** Runs once the handler is armed, before the acquire; a throw is an acquire failure. */
  beforeAcquire?: () => void;
  /** Per-site cleanup on an acquire failure, run BEFORE the listener is removed. */
  onAcquireFailure?: () => void;
}

export interface ReleaseOptions {
  /** Prefix of the warning a failed release logs (it never throws, issue #2168). */
  failureMessage: string;
  /**
   * Work that must finish before the release, with the handler still armed. A
   * throw skips the release (the lock lapses on its TTL) and propagates, but
   * the listener is still removed.
   */
  beforeRelease?: () => Promise<void> | void;
}

export interface HeldStackLock {
  /** True once the first signal arrived — whether before or after the acquire. */
  readonly interrupted: boolean;
  /**
   * Release the lock, then unregister the handler (rule 5), whatever happens.
   * Idempotent: a second call is a no-op, so a `finally` wrapped around a path
   * that already released cannot issue a second, owner-blind release.
   */
  release(opts: ReleaseOptions): Promise<void>;
}

/**
 * Arm the handler and take the lock. Throws, with the listener already
 * removed, when the lock is held elsewhere or the acquire fails.
 *
 * The caller MUST call `release()` on every path once this resolves — in a
 * `finally`, or (the main destroy's strong-reference refusal) on its own exit
 * before that `finally`'s `try` opens.
 */
export async function acquireStackLock(opts: StackLockOptions): Promise<HeldStackLock> {
  const { lockManager, stackName, region, recovery } = opts;
  let interrupted = false;
  let lockHeld = false;
  let released = false;

  const sigintHandler = (): void => {
    if (interrupted) {
      if (lockHeld) {
        void lockManager.releaseLock(stackName, region).catch(() => {
          /* best-effort: the recovery line below is the real guarantee */
        });
        process.stderr.write(
          // cdkd-profile-display: the `recovery.profile` inside `recovery` is
          // an ARGUMENT to `forceQuitRecoveryClause`, not a value this line
          // interpolates. What is rendered is that helper's RETURN, and it
          // sanitizes every `LockRecoveryContext` fragment itself --
          // `displaySafe` plus an EXACTNESS test, suppressing the whole command
          // rather than naming a fragment whose rendering changed (issue
          // go-to-k/cdkd#3377; the behavioural proof is in
          // `tests/unit/state/lock-contention-message.test.ts`). Sanitizing here
          // as well would be wrong, not merely redundant: the helper compares
          // the fragment against the RAW value to decide whether the command
          // can be shown at all, so a pre-sanitized argument would make every
          // altered value compare EXACT and re-open the hole.
          `\nForce-quit: stack lock may not be released.` +
            // Region-qualified (issue #2170), and it matters MORE here than in
            // a contention message: by now `deleteState` may already have
            // removed the record `force-unlock` would infer the region from.
            `${forceQuitRecoveryClause(stackName, region, recovery)}\n`
        );
      }
      process.exit(130);
    }
    interrupted = true;
    try {
      opts.onFirstSignal();
    } catch {
      /* the drain itself is what matters; the notice is best-effort */
    }
  };

  // Each nested-stack level and each in-flight provider that installs its own
  // SIGINT handler adds a listener (that provider set is regenerated by
  // `grep -rn "process.on('SIGINT'" src/provisioning/providers/`), so deep
  // nesting + high `--concurrency` can exceed Node's default cap of 10 and
  // print a MaxListenersExceededWarning that is not a leak. Raise it with
  // headroom, never lowering an already-raised limit, and leave the warning
  // live above it so a REAL leak is not masked.
  process.setMaxListeners(Math.max(process.getMaxListeners(), 100));
  process.on('SIGINT', sigintHandler);

  try {
    opts.beforeAcquire?.();
    // `acquireLock` returns `false` WITHOUT throwing on a live foreign lock
    // (issue #2161), and THROWS a LockError on an S3 failure; both land in the
    // `catch` below.
    const acquired = await lockManager.acquireLock(stackName, region, undefined, opts.operation);
    if (!acquired) {
      throw new Error(
        await buildLockContentionMessage({ lockManager, stackName, region, recovery })
      );
    }
  } catch (error) {
    try {
      opts.onAcquireFailure?.();
    } finally {
      process.removeListener('SIGINT', sigintHandler);
    }
    throw error;
  }
  lockHeld = true;

  return {
    get interrupted() {
      return interrupted;
    },
    async release({ failureMessage, beforeRelease }: ReleaseOptions): Promise<void> {
      if (released) return;
      released = true;
      try {
        await beforeRelease?.();
        try {
          await lockManager.releaseLock(stackName, region);
          // Cleared so a signal arriving after the release cannot fire the
          // force-quit arm's owner-blind delete at a key another process may
          // hold by then. Defensive: nothing suspends between here and the
          // removal below, so no signal can land in between today.
          lockHeld = false;
        } catch (releaseErr) {
          // Warned, never thrown (issue #2168): a 409 / 503 / throttle here
          // would otherwise REPLACE a real failure, or abort a `--all` run over
          // a lock that lapses on its own.
          getLogger().warn(safeMsg`${failureMessage}: ${describeAwsFailure(releaseErr).detail}`);
        }
      } finally {
        // DO NOT add an `await` between this removal and the caller's return:
        // once this handler is gone a second Ctrl-C is answered by
        // `watchCommandInterrupt` (issue #2117), which has no per-stack context
        // and prints only a hedged `cdkd force-unlock <stack-name>`.
        process.removeListener('SIGINT', sigintHandler);
      }
    },
  };
}
