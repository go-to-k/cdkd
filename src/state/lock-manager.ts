import { S3Client, NoSuchKey, S3ServiceException } from '@aws-sdk/client-s3';
import type { LockInfo } from '../types/state.js';
import type { StateBackendConfig } from '../types/config.js';
import { getLogger, type ConsoleLogger } from '../utils/logger.js';
import { expectedOwnerParam } from '../utils/expected-bucket-owner.js';
import { displaySafe } from '../utils/display-safe.js';
import { LockError } from '../utils/error-handler.js';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { markRedactedCause } from '../deployment/retryable-errors/marks.js';
import { currentLogLineMasker } from '../utils/log-line-masker.js';
import { rebuildClientForBucketRegion } from '../utils/bucket-region-client.js';
import { UNRENDERABLE } from './lock-contention-message.js';
import { hostname } from 'os';
import {
  renewalIntervalFor,
  type LockPurgePath,
  type HeldLock,
  stackRef,
  errorDetail,
  isLockInfoExpired,
} from './lock-manager/shared.js';
import { acquireLock, putLockObject, acquireLockWithRetry } from './lock-manager/acquire.js';
import { getLockRecord } from './lock-manager/read.js';
import {
  doReleaseLock,
  stillOursByBody,
  forceReleaseLock,
  deleteLock,
  purgeLockVersions,
} from './lock-manager/release.js';
import { trackHeldLock, doRenewLock, adoptOwnWrite } from './lock-manager/renewal.js';
export {
  abandonedRunHorizon,
  isLockInfoExpired,
  RELEASED_LOCK_REACQUIRE_LIMIT,
} from './lock-manager/shared.js';

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
  /**
   * Let `releaseLock` return once the lock is DELETED, leaving its version
   * purge running (default: false). The owner MUST await
   * {@link LockManager.settleDeferredPurges} before it destroys the S3 client
   * or exits; `cdkd deploy` does, overlapping the purge with its events
   * flush instead of adding it to every deploy's tail.
   */
  deferReleasePurge?: boolean;
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
  logger: ConsoleLogger = getLogger().child('LockManager');

  /**
   * The `LockError` a failed S3 lock call throws, with the failure named by
   * its CLASS (go-to-k/cdkd#2319) -- the shape of `S3StateBackend`'s
   * `wrapS3Failure`, for the same reason: a lock refusal ends the run and is
   * persisted to `deployments/{runId}.jsonl` whole, and S3's `AccessDenied`
   * text names the caller's assumed-role ARN and account id. An AWS-authored
   * failure reaches `build` as `<Class>. Re-run with --verbose for AWS's own
   * message.`, the class through the bound-secret mask and the ASCII
   * allowlist; AWS's own text goes to `debug`; the wrap is stamped
   * `markRedactedCause`. Anything else keeps its text (`errorDetail`). `build`
   * must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor.
   */
  wrapS3Failure(error: unknown, build: (text: string) => LockError): LockError {
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return build(errorDetail(error));
    this.logger.debug(
      build(displaySafe(failure.detail, { asciiOnly: true }) || UNRENDERABLE).message
    );
    const mask = currentLogLineMasker();
    const summary = mask ? mask(failure.summary) : failure.summary;
    const wrapped = build(displaySafe(summary, { asciiOnly: true }) || UNRENDERABLE);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }
  s3Client: S3Client;
  config: StateBackendConfig;
  readonly ttlMs: number;
  private readonly renewalIntervalMs: number;
  readonly renewalDisabled: boolean;
  /** Locks held by THIS process, keyed by S3 lock key. */
  readonly heldLocks = new Map<string, HeldLock>();
  /** By lock key: an expired lock this process took over, and its lease horizon (G-1/B1). */
  readonly abandonedLocks = new Map<string, number>();
  private clientResolved = false;
  private resolveInFlight: Promise<void> | null = null;
  readonly deferReleasePurge: boolean;
  /** Release purges still running under `deferReleasePurge`. */
  readonly deferredPurges = new Set<Promise<void>>();

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
    this.renewalIntervalMs = renewalIntervalFor(this.ttlMs);
    this.deferReleasePurge = options?.deferReleasePurge === true;
  }

  /**
   * Await every release purge `deferReleasePurge` left running. Never throws:
   * `purgeLockVersions` never does. It waits only for the purges started
   * before it is called, so call it after this manager's last release.
   */
  async settleDeferredPurges(): Promise<void> {
    await Promise.all(this.deferredPurges);
  }

  /**
   * `ExpectedBucketOwner` spread for every state-bucket S3 call (squatting
   * hardening — see src/utils/expected-bucket-owner.ts). Best-effort:
   * resolves to an empty object for non-standard clients (test doubles).
   */
  async ownerParam(): Promise<{ ExpectedBucketOwner?: string }> {
    return expectedOwnerParam(this.s3Client);
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
  async ensureClientForBucket(): Promise<void> {
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
  getLockKey(stackName: string, region: string | undefined): string {
    if (region === undefined) {
      return `${this.config.prefix}/${stackName}/lock.json`;
    }
    return `${this.config.prefix}/${stackName}/${region}/lock.json`;
  }

  /**
   * Get default lock owner identifier
   */
  getDefaultOwner(): string {
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
  isLockExpired(lockInfo: LockInfo): boolean {
    return isLockInfoExpired(lockInfo);
  }

  /**
   * Format a human-readable duration from milliseconds
   */
  formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m${remainingSeconds}s`;
  }

  acquireLock(
    stackName: string,
    region: string,
    owner?: string,
    operation?: string
  ): Promise<boolean> {
    return acquireLock.call(this, stackName, region, owner, operation);
  }

  putLockObject(
    key: string,
    lockInfo: LockInfo,
    condition: { IfNoneMatch: string } | { IfMatch: string } = { IfNoneMatch: '*' }
  ): Promise<string | undefined> {
    return putLockObject.call(this, key, lockInfo, condition);
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

  getLockRecord(
    stackName: string,
    region: string | undefined
  ): Promise<{ info: LockInfo; etag: string | undefined; lastModified?: number } | null> {
    return getLockRecord.call(this, stackName, region);
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
      this.logger.debug(
        `Release already in flight (or done) for stack ${stackRef(stackName, region)}`
      );
      return held.releasing;
    }
    if (!held) return this.doReleaseLock(stackName, region, undefined);
    this.stopRenewal(held);
    const releasing = this.doReleaseLock(stackName, region, held);
    held.releasing = releasing;
    return releasing;
  }

  doReleaseLock(stackName: string, region: string, held: HeldLock | undefined): Promise<void> {
    return doReleaseLock.call(this, stackName, region, held);
  }

  stillOursByBody(held: HeldLock): Promise<boolean> {
    return stillOursByBody.call(this, held);
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
  sameLockIdentity(a: LockInfo, b: LockInfo): boolean {
    return displaySafe(a.owner) === displaySafe(b.owner) && a.timestamp === b.timestamp;
  }

  /**
   * go-to-k/cdkd#4705 review G-1/B1: when this process took over an EXPIRED
   * lock of `stackName`, the abandoned run's lease horizon
   * ({@link abandonedRunHorizon}: epoch ms), else `undefined`. Nothing the
   * abandoned run created is later than it.
   */
  abandonedRunEndedBy(stackName: string, region: string | undefined): number | undefined {
    return this.abandonedLocks.get(this.getLockKey(stackName, region));
  }

  forceReleaseLock(
    stackName: string,
    region: string | undefined,
    beforeDelete?: (horizon: number) => Promise<void>
  ): Promise<number | undefined> {
    return forceReleaseLock.call(this, stackName, region, beforeDelete);
  }

  deleteLock(stackName: string, region: string | undefined, etag?: string): Promise<void> {
    return deleteLock.call(this, stackName, region, etag);
  }

  purgeLockVersions(key: string, path: LockPurgePath): Promise<void> {
    return purgeLockVersions.call(this, key, path);
  }

  trackHeldLock(args: {
    stackName: string;
    region: string;
    key: string;
    info: LockInfo;
    etag: string | undefined;
  }): void {
    return trackHeldLock.call(this, args);
  }

  startRenewal(held: HeldLock): void {
    const timer = setInterval(() => {
      void this.renewLock(held);
    }, this.renewalIntervalMs);
    // Never hold the process open for a heartbeat.
    timer.unref?.();
    held.timer = timer;
  }

  stopRenewal(held: HeldLock): void {
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

  doRenewLock(held: HeldLock): Promise<void> {
    return doRenewLock.call(this, held);
  }

  adoptOwnWrite(held: HeldLock, renewed: LockInfo): Promise<boolean> {
    return adoptOwnWrite.call(this, held, renewed);
  }

  /**
   * S3 told us the object is not the one we wrote (someone else replaced it).
   *
   * Matched on the status as well as the name: a 412 arriving as a bare
   * `S3ServiceException`, or under a renamed code, would otherwise skip the
   * "leave it alone" branch and reach the destructive fallback below it.
   */
  isForeignLockError(error: unknown): boolean {
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
  isGoneError(error: unknown): boolean {
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
  isConditionUnsupportedError(error: unknown): boolean {
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
  isNotOursError(error: unknown): boolean {
    return this.isForeignLockError(error) || this.isGoneError(error);
  }

  acquireLockWithRetry(
    stackName: string,
    region: string,
    owner?: string,
    operation?: string,
    maxRetries = 3,
    retryDelay = 2000
  ): Promise<void> {
    return acquireLockWithRetry.call(
      this,
      stackName,
      region,
      owner,
      operation,
      maxRetries,
      retryDelay
    );
  }
}
