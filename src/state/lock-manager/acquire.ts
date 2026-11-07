/**
 * Lock acquisition: `acquireLock`, its conditional PUT, and `acquireLockWithRetry`.
 *
 * Moved verbatim out of `src/state/lock-manager.ts` (go-to-k/cdkd#5835); the
 * `LockManager` class keeps one `f.call(this, ...)` delegator per moved method.
 */
import type { LockManager } from '../lock-manager.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { LockInfo } from '../../types/state.js';
import { displaySafe, safeMsg } from '../../utils/display-safe.js';
import { LockError } from '../../utils/error-handler.js';
import {
  UNREPRODUCIBLE_LOCK_CLAUSE,
  buildForceUnlockCommand,
  formatLockExpiry,
  formatLockOperation,
  formatLockOwner,
} from '../lock-contention-message.js';
import {
  abandonedRunHorizon,
  RELEASED_LOCK_REACQUIRE_LIMIT,
  safeSegment,
  stackRef,
} from './shared.js';

/**
 * Try to acquire a lock for a stack
 *
 * Uses If-None-Match: "*" to ensure atomic lock acquisition.
 * If an expired lock exists, it will be cleaned up and re-acquired.
 *
 * @param stackName Stack name
 * @param region Target region (lock key is region-scoped)
 * @param owner Lock owner identifier (defaults to user@hostname:pid)
 * @param operation Operation being performed (e.g., "deploy", "destroy")
 */
export async function acquireLock(
  this: LockManager,
  stackName: string,
  region: string,
  owner?: string,
  operation?: string
): Promise<boolean> {
  await this.ensureClientForBucket();

  const key = this.getLockKey(stackName, region);
  const lockOwner = owner || this.getDefaultOwner();
  const now = Date.now();

  const lockInfo: LockInfo = {
    owner: lockOwner,
    timestamp: now,
    expiresAt: now + this.ttlMs,
    ...(operation && { operation }),
  };

  try {
    this.logger.debug(`Attempting to acquire lock for stack: ${stackRef(stackName, region)}`);

    const etag = await this.putLockObject(key, lockInfo);

    this.logger.debug(
      `Lock acquired for stack: ${stackRef(stackName, region)}, owner: ${displaySafe(lockOwner)}`
    );
    this.trackHeldLock({ stackName, region, key, info: lockInfo, etag });
    return true;
  } catch (error) {
    // Check for PreconditionFailed error (S3 condition not met - lock already exists)
    if (this.isForeignLockError(error)) {
      this.logger.debug(`Lock already exists for stack: ${stackRef(stackName, region)}`);

      // Check if the existing lock is expired.
      //
      // Read the ETag alongside the body: it is what makes the takeover
      // DELETE below conditional. Since issue #2168 a live holder renews its
      // lock, so "expired" now means the owner has been silent for a whole
      // TTL -- but a renewal that merely lost a race with this read is
      // indistinguishable from a dead owner, and an unconditional delete
      // here would discard that renewed lock. `IfMatch` on the exact bytes
      // we just judged expired closes the window.
      const existing = await this.getLockRecord(stackName, region);
      if (existing && this.isLockExpired(existing.info)) {
        if (existing.etag === undefined) {
          // Without an ETag `deleteLock` is UNCONDITIONAL, which is exactly
          // what the refusal below exists to prevent -- and it would happen
          // silently, with none of that reasoning applied. `trackHeldLock`
          // guards the analogous case for renewal; this site did not.
          this.logger.warn(
            `Cannot take over the expired lock for stack ${stackRef(stackName, region)}: its current ` +
              `version could not be identified, so removing it could delete a lock another process ` +
              `has since taken. Clear it with cdkd force-unlock.`
          );
          return false;
        }

        // Delete the expired lock and retry acquisition. The announcement
        // comes AFTER it succeeds: every branch below can refuse, and a
        // banner saying "both processes will now be writing to the same
        // stack" printed ahead of a refusal that took nothing over is the
        // same log-untruthfulness this change fixes elsewhere.
        try {
          await this.deleteLock(stackName, region, existing.etag);
        } catch (deleteError) {
          if (this.isConditionUnsupportedError(deleteError)) {
            // Do NOT retry unconditionally here, even though `releaseLock`
            // has an escape hatch for the same error class. The `IfMatch` is
            // what makes concurrent REAPING safe: two processes that judge
            // the same lock expired both try to delete it, the first wins
            // and the second gets a 412 and reports contention. Drop the
            // condition and both win -- each deletes whatever is present,
            // then each `IfNoneMatch: '*'` PUT succeeds against the key it
            // just emptied, and the stack has two holders with nothing to
            // say so. The owner's own renewal landing between our read and
            // this call is the second way to reach it, and the renewal loop
            // deliberately keeps retrying past expiry. Refusing costs an
            // unreclaimable expired lock under one specific policy, which
            // `force-unlock` clears; the alternative costs mutual exclusion.
            this.logger.warn(
              `Cannot take over the expired lock for stack ${stackRef(stackName, region)}: this endpoint ` +
                `or policy will not evaluate a conditional delete, and removing it unconditionally ` +
                `could delete a lock another process has since taken. Clear it with cdkd force-unlock.`
            );
            return false;
          } else if (this.isNotOursError(deleteError)) {
            // The lock changed between our read and our delete -- either the
            // owner renewed it or a third process took it over first. Either
            // way it is NOT ours to remove, and it is NOT free.
            this.logger.debug(
              `Expired lock for stack ${stackRef(stackName, region)} changed before takeover; treating as contended`
            );
            return false;
          } else {
            throw deleteError;
          }
        }

        // Two explanations, because `isLockExpired` reaches "expired" two
        // ways: a deadline in the past, or one that is not a finite number
        // (issue #3083). The crashed-owner story is only evidence for the
        // first; for the second the honest cause is the record itself.
        const why = Number.isFinite(existing.info.expiresAt)
          ? `A live cdkd process renews its lock well inside the TTL, so this normally means the ` +
            `previous owner crashed or was suspended`
          : `Its expiresAt is not a finite number, which cdkd treats as already expired`;
        this.logger.warn(
          `Took over an EXPIRED lock for stack: ${safeSegment(stackName)} (${safeSegment(region)}, owner: ${formatLockOwner(existing.info.owner)}, ` +
            `${formatLockExpiry(existing.info.expiresAt)}). ${why} -- ` +
            `if it is in fact still running, both processes are now writing to the same stack.`
        );

        // go-to-k/cdkd#4705 review G-1/B1: the abandoned run's lease
        // horizon -- its last renewal plus that lock's renewal interval.
        // It kept creating between renewals, so nothing it created is
        // later than this.
        const abandonedAt = abandonedRunHorizon(existing);
        if (abandonedAt !== undefined) this.abandonedLocks.set(key, abandonedAt);

        // Retry once after cleaning up expired lock
        try {
          const retryEtag = await this.putLockObject(key, lockInfo);

          this.logger.debug(
            `Lock acquired for stack: ${stackRef(stackName, region)} after expired lock cleanup, owner: ${displaySafe(lockOwner)}`
          );
          this.trackHeldLock({ stackName, region, key, info: lockInfo, etag: retryEtag });
          return true;
        } catch (retryError) {
          if (this.isForeignLockError(retryError)) {
            // Another process acquired the lock between our delete and retry
            this.logger.debug(
              `Lock was acquired by another process during expired lock cleanup for stack: ${stackRef(stackName, region)}`
            );
            return false;
          }
          throw retryError;
        } finally {
          // Issue #2346 site 5, and the ORDER is the whole point: this runs
          // AFTER the re-acquisition PUT, never between the delete above and
          // this retry. Two extra round trips inside that window would widen
          // the delete-then-reacquire race the `isForeignLockError(retryError)`
          // arm below reports ("another process acquired the lock between our
          // delete and retry"); after the PUT they widen nothing, and by then the
          // takeover's own delete marker has gone noncurrent so the purge
          // collects it too.
          //
          // This is the path that reclaims a CRASHED run's chain: the dead
          // owner never released, so its renewal versions are collected by
          // whoever reaps its lock. `IfMatch` on the delete is still the only
          // thing serializing concurrent reapers -- the purge only ever
          // touches `IsLatest === false` rows, so it can neither take the new
          // current lock nor stand in for the condition.
          //
          // WARN level here, unlike the release path: a takeover is rare and
          // already prints a warning of its own.
          await this.purgeLockVersions(key, 'reap');
        }
      }

      return false;
    }

    // Sanitized for the same reason as `acquireLockWithRetry`'s own throw
    // (issue [#2610] review): this LockError is raised from `acquireLock`,
    // which `acquireLockWithRetry` calls UNCAUGHT — so it reaches the same
    // terminal and the same persisted events store through the very path
    // that fix covers, and leaving it raw would make that fix conditional on
    // which of the two threw.
    throw this.wrapS3Failure(
      error,
      (text) =>
        new LockError(
          `Failed to acquire lock for stack ` +
            `${safeSegment(stackName)} ` +
            `(${safeSegment(region)}): ` +
            // Two-of-three is the exact shape `custom-resource-provider.ts`'s
            // cleanup line argues against; `errorDetail` says why.
            text,
          error instanceof Error ? error : undefined
        )
    );
  }
}

/**
 * Write the lock object and return the ETag S3 assigned it.
 *
 * `condition` defaults to `IfNoneMatch: '*'` (acquisition -- succeed only if
 * no current version exists). Renewal passes `IfMatch: <etag>` instead.
 */
export async function putLockObject(
  this: LockManager,
  key: string,
  lockInfo: LockInfo,
  condition: { IfNoneMatch: string } | { IfMatch: string } = { IfNoneMatch: '*' }
): Promise<string | undefined> {
  const body = JSON.stringify(lockInfo, null, 2);
  const response = await this.s3Client.send(
    new PutObjectCommand({
      Bucket: this.config.bucket,
      ...(await this.ownerParam()),
      Key: key,
      Body: body,
      ContentLength: Buffer.byteLength(body),
      ContentType: 'application/json',
      ...condition,
    })
  );
  return response.ETag;
}

/**
 * Acquire lock with retry logic
 *
 * Retries up to maxRetries times with retryDelay between attempts.
 * If lock is expired, cleans it up automatically.
 * On failure, provides helpful message with lock owner and expiry information.
 *
 * A failed acquire followed by a read that finds NO lock means the holder
 * released it in between (issue #4055), so that read re-attempts at once
 * without spending a retry -- up to `RELEASED_LOCK_REACQUIRE_LIMIT` times per
 * call, so a lock that keeps flapping cannot loop forever. `getLockInfo`
 * also returns null for a lock.json whose body is not an object, which
 * `acquireLock` can never replace; the limit is what ends that case too, and
 * after it an empty read waits `retryDelay` like a held lock.
 *
 * @param stackName Stack name
 * @param owner Lock owner identifier
 * @param operation Operation being performed
 * @param maxRetries Maximum number of retries (default: 3)
 * @param retryDelay Delay between retries in milliseconds (default: 2000)
 */
export async function acquireLockWithRetry(
  this: LockManager,
  stackName: string,
  region: string,
  owner?: string,
  operation?: string,
  maxRetries = 3,
  retryDelay = 2000
): Promise<void> {
  let attempts = 0;
  let releasedReacquires = 0;
  // The read taken right after the LAST failed acquire. The refusal below
  // renders THIS rather than re-reading: a second read is one more window for
  // the holder to release, and a release there is exactly how the pre-#4055
  // message came to claim a lock that no longer existed.
  let lockInfo: LockInfo | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts++;
    const acquired = await this.acquireLock(stackName, region, owner, operation);

    if (acquired) {
      return;
    }

    lockInfo = await this.getLockInfo(stackName, region);

    if (!lockInfo && releasedReacquires < RELEASED_LOCK_REACQUIRE_LIMIT) {
      // Released between the failed PUT and this read: try again NOW, and do
      // not count it as a retry -- on the final attempt this is the whole
      // fix, since the loop would otherwise end on a lock that is gone.
      releasedReacquires++;
      this.logger.debug(
        safeMsg`Lock for stack ${stackRef(stackName, region)} could not be acquired, yet no readable lock was found -- most likely released in between; re-attempting (${releasedReacquires}/${RELEASED_LOCK_REACQUIRE_LIMIT})`
      );
      attempt--;
      continue;
    }

    if (attempt < maxRetries) {
      // The retry line is the SIBLING of the throw below and renders the
      // same two values, so it takes the same sanitization -- as does every
      // other stack-name render in this module since issue #3027.
      // `owner` / `operation` go through `formatLockOwner` /
      // `formatLockOperation`, like every lock render (go-to-k/cdkd#4115).
      const holder = lockInfo
        ? `is locked by ${formatLockOwner(lockInfo.owner)}` +
          `${lockInfo.operation ? ` (operation: ${formatLockOperation(lockInfo.operation)})` : ''}` +
          `. Lock ${formatLockExpiry(lockInfo.expiresAt)}.`
        : `could not be locked, and no readable lock was found.`;
      this.logger.info(
        `Stack ${safeSegment(stackName)} ` +
          `(${safeSegment(region)}) ${holder}` +
          ` Retrying in ${this.formatDuration(retryDelay)}... (attempt ${attempt + 1}/${maxRetries})`
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }

  // Failed to acquire lock after all retries
  const expiry = lockInfo ? formatLockExpiry(lockInfo.expiresAt) : undefined;

  // Issue [#2610] site 14. This used to read "Use --force-unlock to manually
  // release the lock", and NO `--force-unlock` Option is registered anywhere
  // in `src/` -- `force-unlock` is a SUBCOMMAND (`cdkd force-unlock
  // <stack>`), and `./lock-contention-message.ts` exists precisely to build
  // that line with the `--stack-region` qualifier that decides WHICH lock
  // object it resolves to. Six sibling contention sites already went through
  // that builder; this one bypassed it.
  //
  // `buildForceUnlockCommand` returns '' when ANY value it would name has
  // nothing that can be reproduced safely on a command line -- five of them
  // since go-to-k/cdkd#3377 widened the guard to the profile, state bucket and
  // state prefix, so `UNREPRODUCIBLE_LOCK_VALUES` is the list rather than this
  // sentence (go-to-k/cdkd#3390 round 3 found this copy still saying two) --
  // in which case
  // the advice degrades rather than naming a command that would address a
  // DIFFERENT lock -- see that module for why suggesting none is the honest
  // answer there.
  //
  // No `LockRecoveryContext` is threaded: `acquireLockWithRetry` is handed a
  // stack name and a region and holds neither the caller's `--profile` nor
  // the resolved state bucket. The command is therefore region-qualified but
  // not account-qualified, which is strictly better than the flag that does
  // not exist; widening it means threading the context through all four
  // callers and is left to issue [#2610].
  const forceUnlockCommand = buildForceUnlockCommand(stackName, region);
  // The suppression sentence is the SHARED one, not a third spelling of it
  // (issue [#2610] review): `forceQuitRecoveryClause` emits the same clause,
  // and `lock-contention-message.ts`'s header records that copies are how the
  // next one drifts.
  const recovery = forceUnlockCommand
    ? `If you are certain no other process is active, run: ${forceUnlockCommand}`
    : `If you are certain no other process is active, ` +
      `${UNREPRODUCIBLE_LOCK_CLAUSE.charAt(0).toLowerCase()}${UNREPRODUCIBLE_LOCK_CLAUSE.slice(1)}`;
  // Sanitize the HEAD too (issue [#2610] review). Suppressing the COMMAND for
  // an unreproducible name while printing that same name raw one sentence
  // earlier closes nothing: a `stackName` carrying a newline plus an ESC
  // sequence forges the very `run:` line the suppression exists to prevent,
  // and this message is not display-only -- it reaches the terminal AND the
  // persisted `deployments/*.jsonl`. `buildLockContentionMessage` already
  // renders its own head this way; this site had adopted only the
  // suppression half of that precedent.
  const safeStack = safeSegment(stackName);
  const safeRegion = safeSegment(region);
  // The no-lock arm must not claim a lock exists (issue #4055): the last read
  // found none. It is either a lock released and re-taken faster than the
  // re-attempts above, or a lock.json that is not a readable lock -- only the
  // second needs `force-unlock`, so the command is conditioned on a repeat.
  // No apostrophe anywhere before the command: one flips the quote parity of
  // a pasted sentence (lock-contention-message.md).
  throw new LockError(
    `Failed to acquire lock for stack ${safeStack} (${safeRegion}) after ${attempts} attempt${attempts === 1 ? '' : 's'}. ` +
      (lockInfo
        ? `Locked by: ${formatLockOwner(lockInfo.owner)}` +
          `${lockInfo.operation ? `, operation: ${formatLockOperation(lockInfo.operation)}` : ''}` +
          `, ${expiry}. ` +
          recovery
        : `No lock could be read after the last failed attempt, so it was most likely released ` +
          `just now: re-run the command. If this repeats, lock.json may hold a body that is not ` +
          `a readable lock. ${recovery}`)
  );
}
