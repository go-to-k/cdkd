import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  NoSuchKey,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import type { LockInfo } from '../types/state.js';
import type { StateBackendConfig } from '../types/config.js';
import { getLogger } from '../utils/logger.js';
import { expectedOwnerParam } from '../utils/expected-bucket-owner.js';
import { displaySafe } from '../utils/display-safe.js';
import { LockError } from '../utils/error-handler.js';
import { rebuildClientForBucketRegion } from '../utils/bucket-region-client.js';
import { hostname } from 'os';

/**
 * Options for LockManager constructor
 */
export interface LockManagerOptions {
  /** Lock TTL in minutes (default: 30) */
  ttlMinutes?: number;
  /**
   * Disable the background renewal loop (default: false).
   *
   * Only for tests that need a lock to actually reach its TTL. Production
   * callers must never set this: a lock that stops being renewed is exactly
   * the pre-issue-#2168 behaviour, where an operation outliving its TTL
   * silently loses mutual exclusion.
   */
  disableRenewal?: boolean;
}

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

/**
 * A lock this process currently believes it holds.
 *
 * `etag` is the S3 ETag of the lock object as this process last wrote it, and
 * it is what makes both renewal and release CONDITIONAL: every subsequent
 * write carries `IfMatch: etag`, so a process that has already lost the lock
 * can neither resurrect its own expiry nor delete the new owner's lock.
 */
interface HeldLock {
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
 * S3-based lock manager using conditional writes (If-None-Match)
 *
 * Implements distributed locking using S3's If-None-Match: "*" condition
 * which ensures atomic lock acquisition.
 *
 * Locks have a TTL (time-to-live). Expired locks are automatically cleaned up
 * during acquisition attempts.
 *
 * Like `S3StateBackend`, the lock manager tolerates a state bucket that
 * lives in a different AWS region from the CLI's base region: before the
 * first S3 operation it resolves the bucket's actual region via
 * `GetBucketLocation` and, if it differs from the supplied client's region,
 * builds a private replacement client for that region (issue #803 — without
 * this, every lock acquisition against a cross-region bucket failed with
 * S3's 301 PermanentRedirect while state reads/writes succeeded).
 */
export class LockManager {
  private logger = getLogger().child('LockManager');
  private s3Client: S3Client;
  private config: StateBackendConfig;
  private readonly ttlMs: number;
  private readonly renewalIntervalMs: number;
  private readonly renewalDisabled: boolean;
  /** Locks held by THIS process, keyed by S3 lock key. */
  private readonly heldLocks = new Map<string, HeldLock>();
  private clientResolved = false;
  private resolveInFlight: Promise<void> | null = null;

  constructor(s3Client: S3Client, config: StateBackendConfig, options?: LockManagerOptions) {
    this.s3Client = s3Client;
    this.config = config;
    const ttlMinutes = options?.ttlMinutes ?? 30;
    if (!(ttlMinutes > 0) || !Number.isFinite(ttlMinutes)) {
      throw new LockError(
        `Lock TTL must be a positive number of minutes (got ${String(ttlMinutes)}). ` +
          `A non-positive TTL makes every lock born expired, and the renewal interval clamps to its ` +
          `floor, so the heartbeat would spin one request per second for the life of the process.`
      );
    }
    this.ttlMs = ttlMinutes * 60 * 1000;
    this.renewalDisabled = options?.disableRenewal === true;
    this.renewalIntervalMs = Math.max(
      MIN_RENEWAL_INTERVAL_MS,
      Math.min(MAX_RENEWAL_INTERVAL_MS, Math.floor(this.ttlMs / RENEWAL_TTL_FRACTION))
    );
  }

  /**
   * Resolve the state bucket's actual region and, if it differs from the
   * supplied client's configured region, replace the client reference with
   * a new S3Client pointed at the bucket's region.
   *
   * Mirrors `S3StateBackend.ensureClientForBucket()` (PR #60) with two
   * deliberate differences:
   *
   * - The replacement client reuses the original client's resolved
   *   credentials provider, so `--profile` / static credentials carry over
   *   without the 8 LockManager call sites having to thread client options.
   * - The original client is NOT destroyed. It is the shared `AwsClients.s3`
   *   instance that other components (state backend, exports index) still
   *   hold a reference to.
   *
   * `resolveBucketRegion` caches per bucket name for the process lifetime,
   * so when the state backend has already resolved the same bucket this
   * incurs no additional `GetBucketLocation` call.
   */
  /**
   * `ExpectedBucketOwner` spread for every state-bucket S3 call (squatting
   * hardening — see src/utils/expected-bucket-owner.ts). Best-effort:
   * resolves to an empty object for non-standard clients (test doubles).
   */
  private async ownerParam(): Promise<{ ExpectedBucketOwner?: string }> {
    return expectedOwnerParam(this.s3Client);
  }

  private async ensureClientForBucket(): Promise<void> {
    if (this.clientResolved) return;
    if (this.resolveInFlight) return this.resolveInFlight;

    this.resolveInFlight = (async (): Promise<void> => {
      try {
        // The LockManager does NOT thread --profile / static credentials; it
        // reuses the supplied client's resolved credentials provider for both
        // the probe and the rebuild, and does NOT destroy the original client
        // (it is the shared `AwsClients.s3` instance other components hold).
        const replacement = await rebuildClientForBucketRegion(this.s3Client, this.config.bucket, {
          reuseClientCredentials: true,
          onRebuild: ({ bucketRegion, currentRegion }) => {
            this.logger.debug(
              `State bucket '${this.config.bucket}' is in '${bucketRegion}' (lock client was '${String(currentRegion)}'); building a region-corrected S3 client for lock operations.`
            );
          },
        });
        if (replacement) {
          this.s3Client = replacement;
        }
        this.clientResolved = true;
      } finally {
        this.resolveInFlight = null;
      }
    })();

    return this.resolveInFlight;
  }

  /**
   * Get the S3 key for a stack's lock file.
   *
   * Locks are region-scoped, mirroring the state key layout
   * (`{prefix}/{stackName}/{region}/lock.json`). Two regions of the same
   * stackName can therefore be operated on in parallel without contention,
   * matching cdkd's parallel execution model.
   *
   * The `region` argument is required for new callers; for backwards
   * compatibility with `state list --long` (which only sees stack names),
   * passing `undefined` falls back to the legacy `{prefix}/{stackName}/lock.json`
   * key — that mode is purely for legacy lock cleanup and is NOT used by
   * deploy / destroy / diff anymore.
   */
  private getLockKey(stackName: string, region: string | undefined): string {
    if (region === undefined) {
      return `${this.config.prefix}/${stackName}/lock.json`;
    }
    return `${this.config.prefix}/${stackName}/${region}/lock.json`;
  }

  /**
   * Get default lock owner identifier
   */
  private getDefaultOwner(): string {
    try {
      const host = hostname();
      const user = process.env['USER'] || process.env['USERNAME'] || 'unknown';
      const pid = process.pid;
      return `${user}@${host}:${pid}`;
    } catch {
      return `cdkd:${process.pid}`;
    }
  }

  /**
   * Check if a lock is expired based on its expiresAt field
   */
  private isLockExpired(lockInfo: LockInfo): boolean {
    // `expiresAt` reaches here through an unvalidated `as LockInfo`, so anyone
    // who can write the state bucket chooses it. `undefined`, `'soon'`, `NaN`
    // and `Infinity` all make a naive `Date.now() >= x` false FOREVER, which
    // pins the stack: no acquire ever succeeds and only `force-unlock` clears
    // it. Treating a non-finite deadline as already expired is the recoverable
    // direction and grants no new power -- someone who can write that value
    // could equally have deleted the object.
    if (!Number.isFinite(lockInfo.expiresAt)) return true;
    return Date.now() >= lockInfo.expiresAt;
  }

  /**
   * Format a human-readable duration from milliseconds
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m${remainingSeconds}s`;
  }

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
  async acquireLock(
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
      this.logger.debug(`Attempting to acquire lock for stack: ${stackName} (${region})`);

      const etag = await this.putLockObject(key, lockInfo);

      this.logger.debug(`Lock acquired for stack: ${stackName} (${region}), owner: ${lockOwner}`);
      this.trackHeldLock({ stackName, region, key, info: lockInfo, etag });
      return true;
    } catch (error) {
      // Check for PreconditionFailed error (S3 condition not met - lock already exists)
      if (this.isForeignLockError(error)) {
        this.logger.debug(`Lock already exists for stack: ${stackName} (${region})`);

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
              `Cannot take over the expired lock for stack '${stackName}' (${region}): its current ` +
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
                `Cannot take over the expired lock for stack '${stackName}' (${region}): this endpoint ` +
                  `or policy will not evaluate a conditional delete, and removing it unconditionally ` +
                  `could delete a lock another process has since taken. Clear it with cdkd force-unlock.`
              );
              return false;
            } else if (this.isNotOursError(deleteError)) {
              // The lock changed between our read and our delete -- either the
              // owner renewed it or a third process took it over first. Either
              // way it is NOT ours to remove, and it is NOT free.
              this.logger.debug(
                `Expired lock for stack ${stackName} (${region}) changed before takeover; treating as contended`
              );
              return false;
            } else {
              throw deleteError;
            }
          }

          this.logger.warn(
            `Took over an EXPIRED lock for stack: ${stackName} (${region}, owner: ${existing.info.owner}, ` +
              `expired ${this.formatDuration(now - existing.info.expiresAt)} ago). A live cdkd process renews its ` +
              `lock well inside the TTL, so this normally means the previous owner crashed or was suspended -- ` +
              `if it is in fact still running, both processes are now writing to the same stack.`
          );

          // Retry once after cleaning up expired lock
          try {
            const retryEtag = await this.putLockObject(key, lockInfo);

            this.logger.debug(
              `Lock acquired for stack: ${stackName} (${region}) after expired lock cleanup, owner: ${lockOwner}`
            );
            this.trackHeldLock({ stackName, region, key, info: lockInfo, etag: retryEtag });
            return true;
          } catch (retryError) {
            if (this.isForeignLockError(retryError)) {
              // Another process acquired the lock between our delete and retry
              this.logger.debug(
                `Lock was acquired by another process during expired lock cleanup for stack: ${stackName} (${region})`
              );
              return false;
            }
            throw retryError;
          }
        }

        return false;
      }

      throw new LockError(
        `Failed to acquire lock for stack '${stackName}' (${region}): ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Write the lock object and return the ETag S3 assigned it.
   *
   * `condition` defaults to `IfNoneMatch: '*'` (acquisition -- succeed only if
   * no current version exists). Renewal passes `IfMatch: <etag>` instead.
   */
  private async putLockObject(
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
   * Get current lock information.
   *
   * `region` is required for the new region-scoped lock layout. Pass
   * `undefined` only to inspect a legacy `{prefix}/{stackName}/lock.json`
   * file (e.g. for state-listing tools that don't yet know the region).
   */
  async getLockInfo(stackName: string, region: string | undefined): Promise<LockInfo | null> {
    const record = await this.getLockRecord(stackName, region);
    return record ? record.info : null;
  }

  /**
   * `getLockInfo` plus the S3 ETag of the object the info came from.
   *
   * Internal because the ETag is only meaningful to code that then issues a
   * CONDITIONAL write or delete against the exact bytes it read (issue #2168):
   * the expired-lock takeover in `acquireLock`. Every public reader wants the
   * body alone.
   */
  private async getLockRecord(
    stackName: string,
    region: string | undefined
  ): Promise<{ info: LockInfo; etag: string | undefined } | null> {
    await this.ensureClientForBucket();

    const key = this.getLockKey(stackName, region);

    try {
      this.logger.debug(`Getting lock info for stack: ${stackName}`);

      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          ...(await this.ownerParam()),
          Key: key,
        })
      );

      if (!response.Body) {
        throw new LockError(`Lock file for stack '${stackName}' has no body`);
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
      const raw: unknown = JSON.parse(bodyString);
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        this.logger.debug(`Lock file for stack ${stackName} is not an object; treating as absent`);
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
      };

      this.logger.debug(`Lock info for stack: ${stackName}:`, lockInfo);

      return { info: lockInfo, etag: response.ETag };
    } catch (error) {
      if (error instanceof NoSuchKey) {
        this.logger.debug(`No lock exists for stack: ${stackName}`);
        return null;
      }

      if (error instanceof LockError) {
        throw error;
      }

      throw new LockError(
        `Failed to get lock info for stack '${stackName}': ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Check whether a lock currently exists for a stack
   *
   * Returns true if a lock file is present in S3 (regardless of expiry).
   * This is intended for read-only inspection (e.g. `cdkd state list --long`),
   * not for acquisition decisions — use `acquireLock` for that, which has its
   * own expired-lock cleanup logic.
   */
  async isLocked(stackName: string, region: string | undefined): Promise<boolean> {
    const lockInfo = await this.getLockInfo(stackName, region);
    return lockInfo !== null;
  }

  /**
   * Release a lock for a stack.
   *
   * The DELETE is CONDITIONAL on the ETag this process last wrote (issue
   * #2168). Before that it was an owner-blind unconditional delete, which is
   * what turned a single lost lock into a cascade: an operation that outlived
   * its TTL had its lock taken over by a second process, then deleted the
   * SECOND process's lock on its way out, freeing the stack for a third.
   *
   * A `PreconditionFailed` therefore means "the object here is not the one I
   * wrote", and the correct response is to leave it alone -- not to raise, as
   * the operation itself has already finished and its caller has nothing to do
   * about it.
   *
   * The condition is dropped for exactly ONE class of failure: the endpoint or
   * the policy will not EVALUATE it (403 / 501 -- see
   * `isConditionUnsupportedError`), and even then only after an ownership
   * re-check. Everything else RAISES, as this method always has. In particular
   * a 409 (S3's answer to a concurrent operation on the key) and a 503 are not
   * fallback-worthy: the first IS the contended case, and the second may mean
   * the delete already landed with the response lost. The heartbeat is stopped
   * by then, so the worst outcome of raising is a lock that lapses at its TTL
   * -- recoverable, unlike one deleted out from under a live writer.
   *
   * Callers must therefore tolerate a throw here, and all sixteen do: four
   * wrap it in `try`/`catch` (`deploy-engine.ts` plus three in
   * `destroy-runner.ts`) and twelve attach a `.catch()`: a
   * failed release is a warning, never the error a command reports.
   */
  async releaseLock(stackName: string, region: string): Promise<void> {
    // `async` is load-bearing in BOTH directions. The body of an async
    // function runs synchronously up to its first `await`, and there is none
    // before the claim below -- so a second caller still cannot slip past it.
    // And every throw in here becomes a REJECTION: `logger.debug` reaches
    // stdout, which this repo has measured throwing EPIPE synchronously under
    // `--verbose | head`, and twelve call sites attach only a `.catch()`. Two of
    // them are `void releaseLock(...).catch(...)` inside a SIGINT force-quit
    // handler, where a synchronous throw is an uncaughtException that kills
    // the handler before its recovery banner prints.
    const key = this.getLockKey(stackName, region);
    const held = this.heldLocks.get(key);
    if (held?.releasing) {
      this.logger.debug(`Release already in flight (or done) for stack ${stackName} (${region})`);
      return held.releasing;
    }
    if (!held) return this.doReleaseLock(stackName, region, undefined);
    this.stopRenewal(held);
    const releasing = this.doReleaseLock(stackName, region, held);
    held.releasing = releasing;
    return releasing;
  }

  private async doReleaseLock(
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

    if (held?.lost) {
      this.logger.warn(
        `Not releasing the lock for stack '${stackName}' (${region}): this process lost it while the ` +
          `operation was still running, so the lock present now belongs to someone else.`
      );
      return;
    }

    if (held && held.etag === undefined && !(await this.stillOursByBody(held))) {
      // No ETag means the DELETE below would be UNCONDITIONAL -- the
      // owner-blind delete this whole change removes, arriving by omission
      // rather than by decision. Confirm ownership by body first, or leave it.
      this.logger.warn(
        `Not releasing the lock for stack '${stackName}' (${region}): this process never learned which ` +
          `version of the lock it wrote, and could not confirm the one present is its own. It expires ` +
          `on its own, or clear it with cdkd force-unlock.`
      );
      return;
    }

    try {
      this.logger.debug(`Releasing lock for stack: ${stackName} (${region})`);

      await this.deleteLock(stackName, region, held?.etag);

      this.logger.debug(`Lock released for stack: ${stackName} (${region})`);
    } catch (error) {
      if (this.isForeignLockError(error)) {
        this.logger.warn(
          held?.etagUncertain
            ? `Not releasing the lock for stack '${stackName}' (${region}): this process could not ` +
                `confirm which version of the lock it last wrote, so it will not delete one it may not ` +
                `own. The lock clears on its own at ${new Date(held.info.expiresAt).toISOString()}, or ` +
                `immediately with cdkd force-unlock.`
            : `Not releasing the lock for stack '${stackName}' (${region}): it has been replaced since ` +
                `this process acquired it, so another cdkd process now holds it. Leaving it in place.`
        );
        return;
      }

      if (this.isGoneError(error)) {
        this.logger.debug(`Lock for stack ${stackName} (${region}) was already gone`);
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
            `Not releasing the lock for stack '${stackName}' (${region}): the conditional delete could ` +
              `not be evaluated here, and this process could not confirm the lock is still its own. ` +
              `Leaving it in place rather than risk deleting another process's lock. It expires on its ` +
              `own, or clear it with cdkd force-unlock. If this repeats, grant s3:GetObject on the lock ` +
              `key -- a delete conditioned on an ETag requires it.`
          );
          return;
        }
        this.logger.debug(
          `Conditional lock release for stack ${stackName} (${region}) is not supported here ` +
            `(${error instanceof Error ? error.message : String(error)}); retrying unconditionally`
        );
        try {
          await this.deleteLock(stackName, region);
          this.logger.debug(`Lock released for stack: ${stackName} (${region})`);
          return;
        } catch (fallbackError) {
          throw new LockError(
            `Failed to release lock for stack '${stackName}' (${region}): ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
            fallbackError instanceof Error ? fallbackError : undefined
          );
        }
      }

      throw new LockError(
        `Failed to release lock for stack '${stackName}' (${region}): ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
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
  private async stillOursByBody(held: HeldLock): Promise<boolean> {
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
   * Whether two lock bodies name the same acquisition.
   *
   * `owner` is compared through `displaySafe` on BOTH sides: a body read back
   * has been sanitized by `getLockRecord` while the one this process
   * constructed has not, so an unsanitized comparison would never match for a
   * `$USER` or hostname containing a stripped codepoint -- and the process
   * would then disown its own lock.
   */
  private sameLockIdentity(a: LockInfo, b: LockInfo): boolean {
    return displaySafe(a.owner) === displaySafe(b.owner) && a.timestamp === b.timestamp;
  }

  /**
   * Force release a lock regardless of owner or expiry status
   *
   * This is intended for CLI usage (e.g., --force-unlock flag) when a lock
   * is stuck and needs manual intervention.
   *
   * Pass `region: undefined` to operate on a legacy
   * `{prefix}/{stackName}/lock.json` file.
   */
  async forceReleaseLock(stackName: string, region: string | undefined): Promise<void> {
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
    const where = `${stackName}${region ? ` (${region})` : ''}`;
    const lockInfo = await this.getLockInfo(stackName, region).catch(() => null);

    this.logger.warn(
      lockInfo
        ? `Force releasing lock for stack: ${where}, ` +
            `owner: ${lockInfo.owner}` +
            `${lockInfo.operation ? `, operation: ${lockInfo.operation}` : ''}` +
            `, expired: ${this.isLockExpired(lockInfo)}`
        : `Force releasing lock for stack: ${where} (no lock body read — ` +
            `absent or unparseable; deleting the object either way, since a ` +
            `lock cdkd cannot read is a lock nothing else can clear)`
    );

    // If this process happens to be the holder, stop renewing before the
    // delete -- otherwise the next tick would re-create the very lock the user
    // asked to remove.
    const held = this.heldLocks.get(this.getLockKey(stackName, region));
    if (held) {
      this.stopRenewal(held);
      // Mark it released so a later `releaseLock` for the same key does not
      // delete whichever lock has appeared since the user force-unlocked.
      held.releasing = Promise.resolve();
    }

    await this.deleteLock(stackName, region);
  }

  /**
   * Internal method to delete the lock file from S3.
   *
   * When `etag` is supplied the delete is conditional (`IfMatch`), so it
   * removes the object ONLY while it is still byte-identical to the one the
   * caller read or wrote. S3 evaluates the condition against the CURRENT
   * version, which is the right unit here even on the versioned state bucket:
   * the current version IS the live lock.
   */
  private async deleteLock(
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
   * Record a lock this process now holds and start renewing it.
   */
  private trackHeldLock(args: {
    stackName: string;
    region: string;
    key: string;
    info: LockInfo;
    etag: string | undefined;
  }): void {
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
        `Lock renewal is disabled; the lock for ${args.stackName} (${args.region}) will lapse at its TTL`
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
        `No ETag returned when acquiring the lock for ${args.stackName} (${args.region}); ` +
          `renewal disabled for this lock`
      );
      return;
    }

    this.startRenewal(held);
  }

  private startRenewal(held: HeldLock): void {
    const timer = setInterval(() => {
      void this.renewLock(held);
    }, this.renewalIntervalMs);
    // Never hold the process open for a heartbeat.
    timer.unref?.();
    held.timer = timer;
  }

  private stopRenewal(held: HeldLock): void {
    if (held.timer !== undefined) {
      clearInterval(held.timer);
      held.timer = undefined;
    }
  }

  /**
   * Push the lock's `expiresAt` forward, conditional on still owning it.
   *
   * This is what makes the TTL mean "the owner has been silent for TTL"
   * instead of "the operation has been running for TTL". Before issue #2168
   * there was no renewal at all, so any operation slower than the TTL -- an
   * FSx or EMR resource waiting up to an hour, or simply a large stack --
   * had its lock treated as free by the next process while it was still
   * running.
   */
  private renewLock(held: HeldLock): Promise<void> {
    if (held.lost || held.renewing !== undefined || held.etag === undefined) {
      return Promise.resolve();
    }
    const inFlight = this.doRenewLock(held).finally(() => {
      held.renewing = undefined;
    });
    held.renewing = inFlight;
    return inFlight;
  }

  private async doRenewLock(held: HeldLock): Promise<void> {
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
          `Lock renewal for ${held.stackName} (${held.region}) returned no ETag and the object could ` +
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
        `Renewed lock for stack: ${held.stackName} (${held.region}) until ` +
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
          `Lost the lock for stack '${held.stackName}' (${held.region}) while the operation was still ` +
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
        `Lock renewal for stack ${held.stackName} (${held.region}) failed, will retry: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
      // Once enough of them have failed that the deadline has actually passed,
      // say so ONCE at warn. Without this, fourteen consecutive failures --
      // about 28 minutes at the default TTL -- produce output byte-identical
      // to a healthy run while the process keeps deleting AWS resources past
      // its own expiry, and another process is now free to take the lock.
      if (!held.warnedPastExpiry && Date.now() >= held.info.expiresAt) {
        held.warnedPastExpiry = true;
        this.logger.warn(
          `Lock renewal for stack '${held.stackName}' (${held.region}) has been failing long enough ` +
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
  private async adoptOwnWrite(held: HeldLock, renewed: LockInfo): Promise<boolean> {
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
      `Lock renewal for stack ${held.stackName} (${held.region}) reported a conflict, but the object ` +
        `holds this process's own renewal -- adopting it and continuing`
    );
    return true;
  }

  /**
   * S3 told us the object is not the one we wrote (someone else replaced it).
   *
   * Matched on the status as well as the name: a 412 arriving as a bare
   * `S3ServiceException`, or under a renamed code, would otherwise skip the
   * "leave it alone" branch and reach the destructive fallback below it.
   */
  private isForeignLockError(error: unknown): boolean {
    return (
      error instanceof S3ServiceException &&
      (error.name === 'PreconditionFailed' || error.$metadata.httpStatusCode === 412)
    );
  }

  /**
   * S3 told us this OBJECT is not there at all.
   *
   * `NoSuchBucket` is also a 404 and must NOT count: it says nothing about the
   * lock. Read as "gone" it would make `releaseLock` resolve where it used to
   * raise, and -- worse -- make one bucket-level 404 during renewal set
   * `lost`, killing the heartbeat and refusing to release a lock this process
   * still holds.
   */
  private isGoneError(error: unknown): boolean {
    if (error instanceof NoSuchKey) return true;
    if (!(error instanceof S3ServiceException)) return false;
    if (error.name === 'NoSuchBucket') return false;
    return error.name === 'NoSuchKey' || error.$metadata.httpStatusCode === 404;
  }

  /**
   * The endpoint or the policy will not evaluate a conditional delete at all.
   *
   * Deliberately narrow, because this is the one predicate that authorises
   * dropping the ownership check. A conditional delete with a specific ETag
   * additionally requires `s3:GetObject` (AWS documents this for its
   * enforce-conditional-deletes bucket policy), so a policy granting only
   * `s3:DeleteObject` answers 403 -- and an S3-compatible endpoint that has
   * not implemented the header answers 501. Neither says anything about who
   * owns the lock, whereas 409 / 412 / 5xx all do.
   */
  private isConditionUnsupportedError(error: unknown): boolean {
    if (!(error instanceof S3ServiceException)) return false;
    const status = error.$metadata.httpStatusCode;
    return (
      status === 403 ||
      status === 501 ||
      error.name === 'AccessDenied' ||
      error.name === 'Forbidden' ||
      error.name === 'NotImplemented'
    );
  }

  /**
   * Either of the two ways S3 can tell us the lock we thought we held is no
   * longer ours: replaced by someone else (412) or deleted outright (404, e.g.
   * by `cdkd force-unlock`). Both mean stop renewing and do not delete.
   */
  private isNotOursError(error: unknown): boolean {
    return this.isForeignLockError(error) || this.isGoneError(error);
  }

  /**
   * Acquire lock with retry logic
   *
   * Retries up to maxRetries times with retryDelay between attempts.
   * If lock is expired, cleans it up automatically.
   * On failure, provides helpful message with lock owner and expiry information.
   *
   * @param stackName Stack name
   * @param owner Lock owner identifier
   * @param operation Operation being performed
   * @param maxRetries Maximum number of retries (default: 3)
   * @param retryDelay Delay between retries in milliseconds (default: 2000)
   */
  async acquireLockWithRetry(
    stackName: string,
    region: string,
    owner?: string,
    operation?: string,
    maxRetries = 3,
    retryDelay = 2000
  ): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const acquired = await this.acquireLock(stackName, region, owner, operation);

      if (acquired) {
        return;
      }

      // Lock exists and is not expired - show info and possibly retry
      const lockInfo = await this.getLockInfo(stackName, region);

      if (lockInfo) {
        const remainingMs = lockInfo.expiresAt - Date.now();

        if (attempt < maxRetries) {
          this.logger.info(
            `Stack '${stackName}' (${region}) is locked by ${lockInfo.owner}` +
              `${lockInfo.operation ? ` (operation: ${lockInfo.operation})` : ''}` +
              `. Lock expires in ${this.formatDuration(remainingMs)}.` +
              ` Retrying in ${this.formatDuration(retryDelay)}... (attempt ${attempt + 1}/${maxRetries})`
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          continue;
        }
      }
    }

    // Failed to acquire lock after all retries
    const lockInfo = await this.getLockInfo(stackName, region);
    const expiresIn = lockInfo ? this.formatDuration(lockInfo.expiresAt - Date.now()) : 'unknown';

    throw new LockError(
      `Failed to acquire lock for stack '${stackName}' (${region}) after ${maxRetries + 1} attempts. ` +
        (lockInfo
          ? `Locked by: ${lockInfo.owner}` +
            `${lockInfo.operation ? `, operation: ${lockInfo.operation}` : ''}` +
            `, expires in: ${expiresIn}. ` +
            `Use --force-unlock to manually release the lock.`
          : 'Lock exists but could not read lock info.')
    );
  }
}
