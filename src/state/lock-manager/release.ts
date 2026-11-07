/**
 * Lock release: the conditional release, `forceReleaseLock`, the delete, and the version purge.
 *
 * Moved verbatim out of `src/state/lock-manager.ts` (go-to-k/cdkd#5835); the
 * `LockManager` class keeps one `f.call(this, ...)` delegator per moved method.
 */
import type { LockManager } from '../lock-manager.js';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { LockInfo } from '../../types/state.js';
import { displayIdent, STACK_REF_MAX_CODE_POINTS } from '../../utils/display-safe.js';
import { LockError } from '../../utils/error-handler.js';
import { purgeNoncurrentKeyVersions } from '../s3-noncurrent-version-purge.js';
import { formatLockOperation, formatLockOwner } from '../lock-contention-message.js';
import {
  abandonedRunHorizon,
  LOCK_OBJECT_DESCRIPTION,
  stackRef,
  errorDetail,
  type LockPurgePath,
  type HeldLock,
} from './shared.js';

export async function doReleaseLock(
  this: LockManager,
  stackName: string,
  region: string,
  held: HeldLock | undefined
): Promise<void> {
  await this.ensureClientForBucket();

  if (held) {
    // Settle any renewal already in flight FIRST: it is what decides both
    // `etag` and `lost` below, and reading them past it is the race this
    // await exists to close.
    await held.renewing?.catch(() => undefined);
  }

  // The two refusals below return WITHOUT purging, and deliberately (issue
  // #2346 site 5). No delete marker is landed on either arm, so there is
  // nothing this release added to the chain; the versions already there are
  // collected by whichever actor next reaps or releases this lock, since the
  // purge is key-scoped rather than scoped to what this process minted. The
  // purge attaches to the DELETE, not to the method.
  if (held?.lost) {
    this.logger.warn(
      `Not releasing the lock for stack ${stackRef(stackName, region)}: this process lost it while the ` +
        `operation was still running, so the lock present now belongs to someone else.`
    );
    return;
  }

  if (held && held.etag === undefined && !(await this.stillOursByBody(held))) {
    // No ETag means the DELETE below would be UNCONDITIONAL -- the
    // owner-blind delete this whole change removes, arriving by omission
    // rather than by decision. Confirm ownership by body first, or leave it.
    this.logger.warn(
      `Not releasing the lock for stack ${stackRef(stackName, region)}: this process never learned which ` +
        `version of the lock it wrote, and could not confirm the one present is its own. It expires ` +
        `on its own, or clear it with cdkd force-unlock.`
    );
    return;
  }

  try {
    this.logger.debug(`Releasing lock for stack: ${stackRef(stackName, region)}`);

    await this.deleteLock(stackName, region, held?.etag);

    this.logger.debug(`Lock released for stack: ${stackRef(stackName, region)}`);
  } catch (error) {
    if (this.isForeignLockError(error)) {
      this.logger.warn(
        held?.etagUncertain
          ? `Not releasing the lock for stack ${stackRef(stackName, region)}: this process could not ` +
              `confirm which version of the lock it last wrote, so it will not delete one it may not ` +
              `own. The lock clears on its own at ${new Date(held.info.expiresAt).toISOString()}, or ` +
              `immediately with cdkd force-unlock.`
          : `Not releasing the lock for stack ${stackRef(stackName, region)}: it has been replaced since ` +
              `this process acquired it, so another cdkd process now holds it. Leaving it in place.`
      );
      return;
    }

    if (this.isGoneError(error)) {
      this.logger.debug(`Lock for stack ${stackRef(stackName, region)} was already gone`);
      return;
    }

    if (held?.etag !== undefined && this.isConditionUnsupportedError(error)) {
      // The condition could not be EVALUATED here -- a policy granting only
      // `s3:DeleteObject`, or an endpoint without the header. Dropping it is
      // the anti-strand escape hatch, but S3 authorizes BEFORE it evaluates
      // a precondition, so a policy that scopes `s3:GetObject` away from
      // lock.json turns a genuine 412 into this 403 -- and then the
      // unconditional retry deletes the lock of whoever took over. So
      // establish ownership by hand first; only a POSITIVE mismatch refuses,
      // since an unreadable lock is the very case this branch is for.
      if (!(await this.stillOursByBody(held))) {
        this.logger.warn(
          `Not releasing the lock for stack ${stackRef(stackName, region)}: the conditional delete could ` +
            `not be evaluated here, and this process could not confirm the lock is still its own. ` +
            `Leaving it in place rather than risk deleting another process's lock. It expires on its ` +
            `own, or clear it with cdkd force-unlock. If this repeats, grant s3:GetObject on the lock ` +
            `key -- a delete conditioned on an ETag requires it.`
        );
        return;
      }
      this.logger.debug(
        `Conditional lock release for stack ${stackRef(stackName, region)} is not supported here ` +
          `(${errorDetail(error)}); retrying unconditionally`
      );
      try {
        await this.deleteLock(stackName, region);
        this.logger.debug(`Lock released for stack: ${stackRef(stackName, region)}`);
        return;
      } catch (fallbackError) {
        throw this.wrapS3Failure(
          fallbackError,
          (text) =>
            new LockError(
              `Failed to release lock for stack ${stackRef(stackName, region)}: ${text}`,
              fallbackError instanceof Error ? fallbackError : undefined
            )
        );
      }
    }

    throw this.wrapS3Failure(
      error,
      (text) =>
        new LockError(
          `Failed to release lock for stack ${stackRef(stackName, region)}: ${text}`,
          error instanceof Error ? error : undefined
        )
    );
  } finally {
    // Issue #2346 site 5. ONE purge covers BOTH deletes above -- the
    // conditional one and the unconditional escape hatch -- because it is
    // key-scoped rather than scoped to a version this process named.
    //
    // In a `finally` rather than after the successful delete, for the reason
    // `deleteRollbackJournal` gives: skipping the purge whenever the delete
    // failed would leave every readable body behind with nothing said about
    // it, and the `IsLatest` filter makes it safe on every arm -- a key whose
    // delete failed keeps its current version and loses only its history.
    // That includes the two refusal arms reached from the `catch`. On the
    // `etagUncertain` / no-longer-ours arm the current version is ANOTHER
    // process's live lock rather than ours -- which the filter protects
    // exactly the same way, since it excludes whatever is current without
    // caring who wrote it.
    //
    // It cannot mask the `LockError` this block may be throwing:
    // `purgeLockVersions` never throws. Deferred, it still starts here, after
    // the delete; only the wait moves to `settleDeferredPurges`.
    const purge = this.purgeLockVersions(this.getLockKey(stackName, region), 'release');
    if (this.deferReleasePurge) {
      this.deferredPurges.add(purge);
      void purge.finally(() => this.deferredPurges.delete(purge));
    } else {
      await purge;
    }
  }
}

/**
 * Is the stored lock still the one this process acquired?
 *
 * Used only where the ETag condition could not be EVALUATED, to decide
 * whether dropping it is safe. Two earlier cuts of this were wrong in
 * opposite directions and both are worth stating, because the shape recurs:
 *
 * - It short-circuited on `Date.now() < held.info.expiresAt`, reasoning that
 *   nobody could have taken over while our own deadline was ahead. But
 *   `forceReleaseLock` deletes regardless of expiry -- that is its whole
 *   contract -- so a user running `cdkd force-unlock` mid-operation is a
 *   LEGITIMATE takeover the shortcut cannot see. Cross-machine clock skew
 *   reaches the same state without anyone running anything. The shortcut is
 *   gone; the read costs one GetObject on an already-failed path.
 *
 * - It answered TRUE when the read FAILED, to avoid stranding a lock. That
 *   made it inert in exactly the case it exists for: the documented trigger
 *   for the 403 is a policy granting `s3:DeleteObject` without the
 *   `s3:GetObject` a conditional delete needs -- under which this read fails
 *   too. So the guard would wave through precisely the situation it was
 *   added to catch. A failed read now REFUSES.
 *
 * The remaining asymmetry is deliberate and is this method's stated rule: a
 * stranded lock is bounded by the TTL and clearable with `force-unlock`,
 * while a lock deleted out from under a live writer is neither.
 */
export async function stillOursByBody(this: LockManager, held: HeldLock): Promise<boolean> {
  let record: { info: LockInfo; etag: string | undefined } | null;
  try {
    record = await this.getLockRecord(held.stackName, held.region);
  } catch {
    return false;
  }
  // NOT "nothing is there". `getLockRecord` also answers `null` for a body
  // that parses to `42` / `[]` / `null`: the object EXISTS -- it still fails
  // every `IfNoneMatch: '*'` acquire, which is the whole reason
  // `forceReleaseLock` deletes unconditionally -- and it is not this
  // process's. And even for a genuine absence, the gap between this read and
  // the delete is a window in which another process acquires. There is
  // nothing to release in either state, so refuse.
  if (!record) return false;
  return this.sameLockIdentity(record.info, held.info);
}

/**
 * Force release a lock regardless of owner or expiry status
 *
 * This is intended for CLI usage -- it is what the `cdkd force-unlock
 * <stack>` SUBCOMMAND calls -- when a lock is stuck and needs manual
 * intervention. There is no `--force-unlock` FLAG anywhere in `src/`; this
 * comment said there was, and issue [#2610] site 14 records that the message
 * `acquireLockWithRetry` used to raise had inherited the same mistake.
 *
 * Pass `region: undefined` to operate on a legacy
 * `{prefix}/{stackName}/lock.json` file.
 */
/**
 * Remove the stack's lock whoever holds it. Resolves the removed lock's
 * lease horizon ({@link abandonedRunHorizon}) when one was read
 * (go-to-k/cdkd#4705 review G-1/B1: the caller records it as the latest
 * moment the abandoned run can have created anything).
 */
export async function forceReleaseLock(
  this: LockManager,
  stackName: string,
  region: string | undefined,
  /**
   * go-to-k/cdkd#4705 review (d): handed the removed lock's lease horizon
   * BEFORE the delete, so the caller can record it while the lock still
   * fences the stack. Whatever it does -- a rejection included -- the
   * delete follows: it is never gated on this.
   */
  beforeDelete?: (horizon: number) => Promise<void>
): Promise<number | undefined> {
  // The DELETE is UNCONDITIONAL, and that is this method's whole contract: a
  // stuck lock must never make a state record unremovable. `getLockInfo` is
  // consulted for the LOG LINE only. Gating the delete on it (which a
  // previous revision did, once `getLockInfo` began returning `null` for an
  // unreadable body) breaks the contract in the other direction -- a
  // lock.json holding `42` or `[]` reads as absent while still failing every
  // `IfNoneMatch: '*'` acquire, so `cdkd force-unlock` would report "no lock"
  // and delete nothing, forever. A DELETE against a key that genuinely is
  // not there is an idempotent no-op, so the cost of always issuing it is one
  // API call on a command the user ran explicitly.
  //
  // For the same reason it is unconditional with respect to issue #2168's
  // ETag too: `force-unlock` exists precisely to remove a lock this process
  // does NOT own.
  // Keyed on `=== undefined` like `getLockKey`, so an empty region shows as
  // the stand-in rather than as absent while the key names `//lock.json`.
  const where = stackRef(stackName, region);
  const record = await this.getLockRecord(stackName, region).catch(() => null);
  const lockInfo = record?.info ?? null;

  this.logger.warn(
    lockInfo
      ? `Force releasing lock for stack: ${where}, ` +
          `owner: ${formatLockOwner(lockInfo.owner)}` +
          `${lockInfo.operation ? `, operation: ${formatLockOperation(lockInfo.operation)}` : ''}` +
          `, expired: ${this.isLockExpired(lockInfo)}`
      : `Force releasing lock for stack: ${where} (no lock body read — ` +
          `absent or unparseable; deleting the object either way, since a ` +
          `lock cdkd cannot read is a lock nothing else can clear)`
  );

  // If this process happens to be the holder, stop renewing before the
  // delete -- otherwise the next tick would re-create the very lock the user
  // asked to remove.
  const key = this.getLockKey(stackName, region);
  const held = this.heldLocks.get(key);
  if (held) {
    this.stopRenewal(held);
    // Mark it released so a later `releaseLock` for the same key does not
    // delete whichever lock has appeared since the user force-unlocked.
    held.releasing = Promise.resolve();
  }

  const horizon = record ? abandonedRunHorizon(record) : undefined;
  if (horizon !== undefined && beforeDelete !== undefined) {
    await beforeDelete(horizon).catch(() => undefined);
  }

  try {
    await this.deleteLock(stackName, region);
  } finally {
    // Issue #2346 site 5. A REAP, like the takeover above: this is
    // `cdkd force-unlock` (and `cdkd state orphan`), an explicit operator
    // action on a lock this process usually does not own -- so clearing the
    // history of whoever left it behind is the point rather than a side
    // effect, and a failure is worth a warning on a command the user ran on
    // purpose. In a `finally` so a delete that failed still gets the history
    // swept; the `IsLatest` filter keeps whatever is current intact.
    await this.purgeLockVersions(key, 'reap');
  }
  return horizon;
}

/**
 * Internal method to delete the lock file from S3.
 *
 * When `etag` is supplied the delete is conditional (`IfMatch`), so it
 * removes the object ONLY while it is still byte-identical to the one the
 * caller read or wrote. S3 evaluates the condition against the CURRENT
 * version, which is the right unit here even on the versioned state bucket:
 * the current version IS the live lock.
 *
 * EVERY CALLER MUST PAIR THIS WITH {@link purgeLockVersions} (issue
 * [#2346](https://github.com/go-to-k/cdkd/issues/2346) site 5). The delete
 * writes a DELETE MARKER on the versioned state bucket and leaves every
 * prior body readable, so a delete on its own grows the key forever. The
 * purge is NOT folded in here, for two reasons that are both per-call-site:
 * the log level differs (see {@link LockPurgePath}), and the takeover path
 * must purge AFTER its re-acquisition PUT rather than immediately after the
 * delete. `tests/unit/state/lock-noncurrent-version-purge.test.ts` parses
 * this file and fails if a caller of this method does not also call the
 * purge, so a fifth call site cannot quietly skip it.
 */
export async function deleteLock(
  this: LockManager,
  stackName: string,
  region: string | undefined,
  etag?: string
): Promise<void> {
  await this.ensureClientForBucket();

  const key = this.getLockKey(stackName, region);

  await this.s3Client.send(
    new DeleteObjectCommand({
      Bucket: this.config.bucket,
      ...(await this.ownerParam()),
      Key: key,
      ...(etag !== undefined && { IfMatch: etag }),
    })
  );
}

/**
 * Delete the lock key's NONCURRENT versions after a delete marker has been
 * landed on it (issue [#2346](https://github.com/go-to-k/cdkd/issues/2346)
 * site 5).
 *
 * ## Why the lock key needs this at all
 *
 * `cdkd bootstrap` turns VERSIONING ON for the state bucket, so
 * {@link deleteLock} writes a delete marker and every earlier body stays
 * readable through `GetObject` with a `VersionId`. Renewal writes one version
 * every {@link MAX_RENEWAL_INTERVAL_MS} (2 minutes at the default 30-minute
 * TTL, so a 30-minute deploy mints about fifteen), `deleteState` never
 * sweeps the lock key, and nothing else ever did — so the chain was
 * monotonic in stacks EVER deployed. 452 versions were measured on a single
 * key. Nothing in a `LockInfo` is a secret, so this is bucket cost and
 * listing noise rather than disclosure; it is still unbounded.
 *
 * ## Why the SHARED helper, and why that is safe on a lock
 *
 * A per-`VersionId` scheme (remember what this process minted, delete
 * exactly that) was designed and REJECTED on review. Its hazards were all
 * created by the mechanism: deleting one's OWN delete marker resurrects a
 * stale lock whenever a batch partially fails, a per-id delete has no
 * `IsLatest` guard so it can remove the CURRENT version on a refusal branch,
 * a `"null"` version id under suspended versioning is a legal delete target,
 * and the 1000-entry `DeleteObjects` cap forces a re-implementation of the
 * shared helper's batching. The shared helper's `IsLatest` filter removes
 * every one of them: it can never touch what is current, which is exactly
 * the live lock — ours or anyone else's.
 *
 * That filter is also what makes it correct to run this from a `finally`,
 * including on the arms where the delete was REFUSED. Purging noncurrent
 * versions while our own lock is still the current one is harmless.
 *
 * ## Level, and the one UX regression this avoids
 *
 * The four sites already purging (rollback journal, bootstrap marker,
 * transient template, custom-resource response) all warn, because what
 * survives there may be a secret and they fire on rare paths. `lock.json` is
 * neither: it holds no secret and `'release'` fires at the tail of EVERY
 * mutating command. Inheriting WARN would mean a user on the pre-#2340
 * four-action IAM policy starts seeing a warning after every single command,
 * about bucket tidiness. Be precise about WHICH user that is: a principal
 * missing `s3:ListBucketVersions` already gets a warn on every successful
 * deploy from `deleteRollbackJournal`'s purge, so nothing changes for them.
 * The one this split protects is the principal who HAS `ListBucketVersions`
 * but lacks `s3:DeleteObjectVersion` — silent today, and newly noisy without
 * it. So
 * release-path failures go to `debug` and only the rare `'reap'` paths warn,
 * which is the cost profile `docs/state-management.md` means by "only the
 * cleanup paths that need them".
 *
 * A warn-once-per-process dedupe was the other option and is not taken, for
 * the reason `s3-noncurrent-version-purge.ts` gives for rejecting one: it
 * needs module-global state, which this repo has been bitten by under
 * `--stack-concurrency > 1`.
 *
 * NEVER THROWS. The helper guarantees that for itself, but
 * `ensureClientForBucket()` and `ownerParam()` sit outside it, so the wrap
 * below is what makes the contract true. Only `ensureClientForBucket()` is a
 * known rejector (`GetBucketLocation`); `ownerParam()` is NOT — an earlier
 * revision claimed it reached STS, and `src/cli/upload-cfn-template.ts`
 * records that as false, since `resolveExpectedBucketOwner` wraps every
 * await and degrades to `undefined`. Naming an unproved mechanism is worse
 * than naming none. The wrap stays because a caller-supplied logger can
 * throw and because a future edit can add an awaited call here — the same
 * reasoning as
 * `S3StateBackend.purgeNoncurrentVersions`. It matters more here than there:
 * every call site is a `finally`, and a throw from a `finally` REPLACES the
 * `LockError` the release was raising. Nothing on this path is
 * interrupt-aware (`LockManager` starts no interrupt watch and issues no
 * `withRetry`), so there is no `InterruptedWaitError` for the swallow below
 * to hide.
 */
export async function purgeLockVersions(
  this: LockManager,
  key: string,
  path: LockPurgePath
): Promise<void> {
  // TOTAL BY CONSTRUCTION, and that is what makes the never-throw claim above
  // true rather than merely intended. `report` is handed to the shared helper
  // as its `logger.warn` SINK, and the helper calls that sink outside any
  // `try` -- so a sink that throws makes the never-throwing helper throw.
  // `logger.debug` reaches `console.debug` on stdout, which this repo has
  // measured throwing EPIPE SYNCHRONOUSLY under `--verbose | head` (see
  // `releaseLock`'s JSDoc, which exists for that measurement). Every call
  // site of this method is a `finally`, so such a throw would REPLACE the
  // `LockError` the release was raising -- turning a diagnosable lock failure
  // into a broken pipe. Losing a log line is the only safe direction.
  const report = (message: string): void => {
    try {
      if (path === 'reap') this.logger.warn(message);
      else this.logger.debug(message);
    } catch {
      // Deliberately empty: the message is the least important thing on a
      // path whose whole contract is not to disturb its caller.
    }
  };
  try {
    await this.ensureClientForBucket();
    await purgeNoncurrentKeyVersions(this.s3Client, this.config.bucket, [key], {
      requestFields: await this.ownerParam(),
      // The helper's `logger` option is typed as a bare `warn` sink, which
      // is the documented seam for exactly this: the release path routes the
      // helper's own warning to `debug` without the helper knowing.
      logger: { warn: report },
      objectDescription: LOCK_OBJECT_DESCRIPTION,
    });
  } catch (error) {
    report(
      // The key through `displayIdent` AND the error through `errorDetail`,
      // because the key embeds the stack name and -- on the reap paths -- a
      // region this process read out of a lock/state object BODY, and S3's
      // error text echoes that key back (issue #3027).
      `Could not purge noncurrent versions of the lock key ${displayIdent(key, { maxCodePoints: STACK_REF_MAX_CODE_POINTS })} in bucket ` +
        `'${this.config.bucket}': the purge could not be started. Their previous versions ` +
        `survive and remain readable via GetObject with a VersionId (${LOCK_OBJECT_DESCRIPTION}). ` +
        `Grant s3:ListBucketVersions and s3:DeleteObjectVersion on the state bucket, or purge ` +
        `the key by hand. Underlying error: ${errorDetail(error)}`
    );
  }
}
