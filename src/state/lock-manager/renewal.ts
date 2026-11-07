/**
 * The held-lock heartbeat: tracking a held lock and each conditional renewal.
 *
 * Moved verbatim out of `src/state/lock-manager.ts` (go-to-k/cdkd#5835); the
 * `LockManager` class keeps one `f.call(this, ...)` delegator per moved method.
 */
import type { LockManager } from '../lock-manager.js';
import type { LockInfo } from '../../types/state.js';
import { stackRef, errorDetail, type HeldLock } from './shared.js';

/**
 * Record a lock this process now holds and start renewing it.
 */
export function trackHeldLock(
  this: LockManager,
  args: {
    stackName: string;
    region: string;
    key: string;
    info: LockInfo;
    etag: string | undefined;
  }
): void {
  const previous = this.heldLocks.get(args.key);
  if (previous) this.stopRenewal(previous);

  const held: HeldLock = {
    stackName: args.stackName,
    region: args.region,
    key: args.key,
    info: args.info,
    etag: args.etag,
    timer: undefined,
    renewing: undefined,
    lost: false,
    releasing: undefined,
    etagUncertain: false,
    warnedPastExpiry: false,
  };
  this.heldLocks.set(args.key, held);

  if (this.renewalDisabled) {
    this.logger.debug(
      `Lock renewal is disabled; the lock for ${stackRef(args.stackName, args.region)} will lapse at its TTL`
    );
    return;
  }

  if (args.etag === undefined) {
    // Every real S3 PutObject response carries an ETag; only a test double
    // omits it. Renewing without one would mean an UNCONDITIONAL overwrite,
    // which is the one thing renewal must never do -- a process that has
    // already lost the lock would resurrect its own expiry on top of the new
    // owner's lock. Degrading to the pre-#2168 behaviour (lapse at the TTL)
    // is the safe direction.
    this.logger.debug(
      `No ETag returned when acquiring the lock for ${stackRef(args.stackName, args.region)}; ` +
        `renewal disabled for this lock`
    );
    return;
  }

  this.startRenewal(held);
}

export async function doRenewLock(this: LockManager, held: HeldLock): Promise<void> {
  const currentEtag = held.etag;
  // Re-asserted rather than inherited from `renewLock`'s guard: this method
  // is what performs the UNCONDITIONAL-write-forbidding decision, so the
  // condition it depends on has to be visible here.
  if (currentEtag === undefined) return;
  // Declared outside the `try` because the catch needs the exact body this
  // attempt wrote, to tell a lost RESPONSE from a lost LOCK.
  const renewed: LockInfo = { ...held.info, expiresAt: Date.now() + this.ttlMs };
  try {
    const etag = await this.putLockObject(held.key, renewed, { IfMatch: currentEtag });
    if (etag === undefined) {
      // The write landed but we have no handle for the next conditional one.
      // Try to recover it by reading; `adoptOwnWrite` accepts the object only
      // when it is byte-for-byte the body we just wrote.
      if (await this.adoptOwnWrite(held, renewed)) return;
      // Failing that, stop -- but KEEP the last known-good ETag rather than
      // clearing it. Clearing would make the next `releaseLock` silently
      // UNCONDITIONAL, which is precisely the owner-blind delete this change
      // exists to remove. A stale ETag instead makes that release refuse,
      // which strands the lock until its TTL: recoverable, and the safe
      // direction of the two.
      // The PUT succeeded -- only its ETag is missing -- so the stored
      // object IS `renewed`. Recording that keeps the eventual "it clears at
      // ..." message truthful; leaving `held.info` behind made it name a
      // deadline earlier than the real one, so a user who waited it out
      // found the lock still there.
      held.info = renewed;
      held.etagUncertain = true;
      this.stopRenewal(held);
      this.logger.debug(
        `Lock renewal for ${stackRef(held.stackName, held.region)} returned no ETag and the object could ` +
          `not be re-read; stopping renewal and keeping the previous ETag`
      );
      return;
    }
    held.info = renewed;
    held.etag = etag;
    // Re-arm: a later expiry episode is a NEW event and must not be silent
    // because an earlier one already reported itself.
    held.warnedPastExpiry = false;
    this.logger.debug(
      `Renewed lock for stack: ${stackRef(held.stackName, held.region)} until ` +
        `${new Date(renewed.expiresAt).toISOString()}`
    );
  } catch (error) {
    if (this.isForeignLockError(error) && (await this.adoptOwnWrite(held, renewed))) {
      return;
    }
    if (this.isNotOursError(error)) {
      held.lost = true;
      this.stopRenewal(held);
      this.logger.warn(
        `Lost the lock for stack ${stackRef(held.stackName, held.region)} while the operation was still ` +
          `running: the lock object has been replaced or removed. Another cdkd process may now be ` +
          `writing to this stack concurrently. This process will not delete the current lock when it ` +
          `finishes.`
      );
      return;
    }
    // Transient (throttling, network, 409 on a concurrent request). Keep the
    // interval running -- the TTL tolerates many consecutive misses, and
    // giving up on the first one would re-open the very window this closes.
    this.logger.debug(
      `Lock renewal for stack ${stackRef(held.stackName, held.region)} failed, will retry: ` +
        `${errorDetail(error)}`
    );
    // Once enough of them have failed that the deadline has actually passed,
    // say so ONCE at warn. Without this, fourteen consecutive failures --
    // about 28 minutes at the default TTL -- produce output byte-identical
    // to a healthy run while the process keeps deleting AWS resources past
    // its own expiry, and another process is now free to take the lock.
    if (!held.warnedPastExpiry && Date.now() >= held.info.expiresAt) {
      held.warnedPastExpiry = true;
      this.logger.warn(
        `Lock renewal for stack ${stackRef(held.stackName, held.region)} has been failing long enough ` +
          `that the lock expired at ${new Date(held.info.expiresAt).toISOString()}. Another cdkd ` +
          `process can now take it while this operation is still running. Renewal keeps retrying.`
      );
    }
  }
}

/**
 * Recover from a 412 that this process itself caused.
 *
 * A conditional PUT that S3 APPLIED but whose response never arrived -- a
 * dropped connection, or an SDK-internal retry of the same request -- leaves
 * `held.etag` pointing at the PREVIOUS version while the object already
 * holds the renewal. The retry then carries the stale `IfMatch` and S3
 * correctly answers 412. Reading that as "someone took my lock" is wrong in
 * both directions: it stops the heartbeat on a lock this process still owns,
 * it prints a warning naming a concurrent writer that does not exist, and
 * `releaseLock` then refuses to remove the process's OWN lock -- stranding
 * the stack for up to a full TTL, which is strictly worse than the
 * unconditional delete this change replaced.
 *
 * So a 412 is disambiguated by READING the object once. `renewed` is a body
 * only this process could have produced: its `owner` identifies the process
 * and its `expiresAt` is a millisecond timestamp this specific PUT chose. An
 * exact match on both (plus `timestamp`, which is fixed at acquisition) means
 * the write landed and only the answer was lost, so the renewal is adopted
 * rather than mourned.
 *
 * The read is on the 412 path only, which is rare. If it fails, the caller
 * falls through to the pessimistic branch -- an unreadable lock is not
 * evidence of ownership.
 */
export async function adoptOwnWrite(
  this: LockManager,
  held: HeldLock,
  renewed: LockInfo
): Promise<boolean> {
  const record = await this.getLockRecord(held.stackName, held.region).catch(() => null);
  if (
    !record ||
    record.etag === undefined ||
    record.info.expiresAt !== renewed.expiresAt ||
    !this.sameLockIdentity(record.info, renewed)
  ) {
    return false;
  }
  held.info = renewed;
  held.etag = record.etag;
  // An adopted renewal is a successful one: re-arm, or a later expiry
  // episode after an adopt would be silent.
  held.warnedPastExpiry = false;
  this.logger.debug(
    `Lock renewal for stack ${stackRef(held.stackName, held.region)} reported a conflict, but the object ` +
      `holds this process's own renewal -- adopting it and continuing`
  );
  return true;
}
