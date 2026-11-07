/**
 * `getLockRecord`, the lock read every acquire, renewal and release path goes through.
 *
 * Moved verbatim out of `src/state/lock-manager.ts` (go-to-k/cdkd#5835); the
 * `LockManager` class keeps one `f.call(this, ...)` delegator per moved method.
 */
import type { LockManager } from '../lock-manager.js';
import { GetObjectCommand, NoSuchKey } from '@aws-sdk/client-s3';
import type { LockInfo } from '../../types/state.js';
import { displaySafe, safeMsg } from '../../utils/display-safe.js';
import { LockError } from '../../utils/error-handler.js';
import {
  describeJsonParseFailure,
  parseFailureDebugDetail,
  utf8ByteLength,
} from '../../utils/json-parse-failure.js';
import { safeSegment } from './shared.js';

/**
 * `getLockInfo` plus the S3 ETag of the object the info came from.
 *
 * Internal because the ETag is only meaningful to code that then issues a
 * CONDITIONAL write or delete against the exact bytes it read (issue #2168):
 * the expired-lock takeover in `acquireLock`. Every public reader wants the
 * body alone.
 */
export async function getLockRecord(
  this: LockManager,
  stackName: string,
  region: string | undefined
): Promise<{ info: LockInfo; etag: string | undefined; lastModified?: number } | null> {
  await this.ensureClientForBucket();

  const key = this.getLockKey(stackName, region);

  // Debug is quieter than warn, not a different terminal (issue #3003).
  // Above the `try` because the catch logs it too.
  const shownStack = safeSegment(stackName);

  try {
    this.logger.debug(`Getting lock info for stack: ${shownStack}`);

    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        ...(await this.ownerParam()),
        Key: key,
      })
    );

    if (!response.Body) {
      // A `LockError` is rethrown UNCHANGED by the catch below, so this one
      // does not reach the guard there — it needs its own (issue #3003).
      throw new LockError(`Lock file for stack ${shownStack} has no body`);
    }

    const bodyString = await response.Body.transformToString();
    // A body that parses to `null` (or to any non-object) is NOT a lock.
    // Reading `.owner` off it threw inside this `try` and the catch rewrapped
    // it as a `LockError`, turning "no lock" into a hard failure for
    // `isLocked`, `state orphan`, `state list` and `acquireLock`'s
    // PreconditionFailed branch. Returning `null` — rather than an empty
    // `LockInfo`, which a first cut did — is what actually restores the
    // pre-existing behaviour: `isLocked` is `lockInfo !== null`, so an empty
    // object would report the stack as LOCKED and make `state orphan` refuse
    // to remove a record whose lock.json is `null`.
    let raw: unknown;
    try {
      raw = JSON.parse(bodyString);
    } catch (parseError) {
      // V8's `SyntaxError` quotes a window of `lock.json`, so the refusal
      // names only the failure's offset and size and attaches NO cause,
      // which `formatError` would print on its `Caused by:` line (issue
      // #5254). No reader keys on this cause. A `LockError` is rethrown
      // unchanged by the catch below. V8's text goes to `debug` only.
      this.logger.debug(
        safeMsg`Lock file for stack ${shownStack} failed to parse: ${parseFailureDebugDetail(parseError)}`
      );
      throw new LockError(
        `Failed to get lock info for stack ${shownStack}: ` +
          `${describeJsonParseFailure(parseError, utf8ByteLength(bodyString))}`
      );
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      this.logger.debug(`Lock file for stack ${shownStack} is not an object; treating as absent`);
      return null;
    }
    const parsed = raw as LockInfo;
    // Sanitize the DISPLAY fields HERE, at the single point every reader
    // goes through (issue #2170). `owner` and `operation` are attacker-
    // influenced for anyone who can write the state bucket, and they reach a
    // TTY, a thrown `LockError`, and the persisted deployment-events store —
    // five readers, of which the first pass at this fix sanitized ONE.
    // Doing it per-reader is how the next reader inherits nothing.
    //
    // The parse is an unvalidated `as LockInfo`, so `displaySafe` also
    // absorbs a non-string / absent value rather than letting `.replace`
    // throw further downstream.
    const lockInfo: LockInfo = {
      ...parsed,
      owner: displaySafe(parsed.owner),
      ...(parsed.operation !== undefined && { operation: displaySafe(parsed.operation) }),
      // Normalised HERE for the same reason `owner` is: an object whose
      // `toString` is not callable made every reader that subtracted from
      // `expiresAt` throw — five of them at the time, the expired-lock
      // takeover's warning AFTER it had deleted the lock, leaving the stack
      // unlocked (issue #2947). Since issue #3083 four of those test
      // `Number.isFinite` first, which never coerces, so the one reader this
      // still protects is `lock-contention-message.ts`'s subtraction; it
      // stays load-bearing for that one and for any reader added later. Only a
      // value whose coercion THROWS is replaced; every other value passes
      // through untouched, because `isLockExpired` decides on the RAW value:
      // a numeric string is non-finite there and therefore expired, and
      // converting it would move a future string deadline to "live" — the
      // direction only `force-unlock` recovers from.
      expiresAt: nanIfUncoercible(parsed.expiresAt),
    };

    this.logger.debug(`Lock info for stack: ${shownStack}:`, lockInfo);

    return {
      info: lockInfo,
      etag: response.ETag,
      ...(response.LastModified instanceof Date && {
        lastModified: response.LastModified.getTime(),
      }),
    };
  } catch (error) {
    if (error instanceof NoSuchKey) {
      this.logger.debug(`No lock exists for stack: ${shownStack}`);
      return null;
    }

    if (error instanceof LockError) {
      throw error;
    }

    // `cdkd state show` surfaces this message as its fatal error (issue
    // #3003).
    throw this.wrapS3Failure(
      error,
      (text) =>
        new LockError(
          `Failed to get lock info for stack ${shownStack}: ${text}`,
          error instanceof Error ? error : undefined
        )
    );
  }
}

/**
 * `value` itself, unless coercing it to a number THROWS — then `NaN`.
 *
 * Deliberately not a conversion: see the `expiresAt` note in `getLockRecord`.
 * The call is the probe — `Number` throws on exactly the values the readers'
 * arithmetic would throw on, and on nothing else.
 */
function nanIfUncoercible(value: unknown): number {
  try {
    Number(value);
    return value as number;
  } catch {
    return Number.NaN;
  }
}
