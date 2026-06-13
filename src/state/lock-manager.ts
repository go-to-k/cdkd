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
import { LockError } from '../utils/error-handler.js';
import { resolveBucketRegion } from '../utils/aws-region-resolver.js';
import { hostname } from 'os';

/**
 * Options for LockManager constructor
 */
export interface LockManagerOptions {
  /** Lock TTL in minutes (default: 30) */
  ttlMinutes?: number;
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
  private clientResolved = false;
  private resolveInFlight: Promise<void> | null = null;

  constructor(s3Client: S3Client, config: StateBackendConfig, options?: LockManagerOptions) {
    this.s3Client = s3Client;
    this.config = config;
    const ttlMinutes = options?.ttlMinutes ?? 30;
    this.ttlMs = ttlMinutes * 60 * 1000;
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
  private async ensureClientForBucket(): Promise<void> {
    if (this.clientResolved) return;
    if (this.resolveInFlight) return this.resolveInFlight;

    this.resolveInFlight = (async (): Promise<void> => {
      try {
        const currentRegion = await this.s3Client.config.region();
        const fallbackRegion = typeof currentRegion === 'string' ? currentRegion : undefined;

        // Authenticate the GetBucketLocation probe the same way the caller's
        // client does (honors --profile / static credentials). Best-effort:
        // a failure here just downgrades the probe to the default chain, and
        // resolveBucketRegion itself never throws.
        let probeCredentials:
          | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
          | undefined;
        try {
          probeCredentials = await this.s3Client.config.credentials();
        } catch {
          probeCredentials = undefined;
        }

        const bucketRegion = await resolveBucketRegion(this.config.bucket, {
          ...(probeCredentials && { credentials: probeCredentials }),
          ...(fallbackRegion && { fallbackRegion }),
        });

        if (bucketRegion !== currentRegion) {
          this.logger.debug(
            `State bucket '${this.config.bucket}' is in '${bucketRegion}' (lock client was '${currentRegion}'); building a region-corrected S3 client for lock operations.`
          );
          this.s3Client = new S3Client({
            region: bucketRegion,
            credentials: this.s3Client.config.credentials,
            // Suppress "Are you using a Stream of unknown length" warning,
            // matching the suppression in AwsClients.
            logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
          });
          // NOTE: the previous client is intentionally not destroyed here —
          // it is shared with other components via AwsClients.s3.
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

      const lockBody = JSON.stringify(lockInfo, null, 2);
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: lockBody,
          ContentLength: Buffer.byteLength(lockBody),
          ContentType: 'application/json',
          IfNoneMatch: '*', // Only succeed if object doesn't exist
        })
      );

      this.logger.debug(`Lock acquired for stack: ${stackName} (${region}), owner: ${lockOwner}`);
      return true;
    } catch (error) {
      // Check for PreconditionFailed error (S3 condition not met - lock already exists)
      if (error instanceof S3ServiceException && error.name === 'PreconditionFailed') {
        this.logger.debug(`Lock already exists for stack: ${stackName} (${region})`);

        // Check if the existing lock is expired
        const existingLock = await this.getLockInfo(stackName, region);
        if (existingLock && this.isLockExpired(existingLock)) {
          this.logger.info(
            `Expired lock detected for stack: ${stackName} (${region}, owner: ${existingLock.owner}, ` +
              `expired ${this.formatDuration(now - existingLock.expiresAt)} ago). Cleaning up...`
          );

          // Delete the expired lock and retry acquisition
          await this.deleteLock(stackName, region);

          // Retry once after cleaning up expired lock
          try {
            const retryBody = JSON.stringify(lockInfo, null, 2);
            await this.s3Client.send(
              new PutObjectCommand({
                Bucket: this.config.bucket,
                Key: key,
                Body: retryBody,
                ContentLength: Buffer.byteLength(retryBody),
                ContentType: 'application/json',
                IfNoneMatch: '*',
              })
            );

            this.logger.debug(
              `Lock acquired for stack: ${stackName} (${region}) after expired lock cleanup, owner: ${lockOwner}`
            );
            return true;
          } catch (retryError) {
            if (
              retryError instanceof S3ServiceException &&
              retryError.name === 'PreconditionFailed'
            ) {
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
   * Get current lock information.
   *
   * `region` is required for the new region-scoped lock layout. Pass
   * `undefined` only to inspect a legacy `{prefix}/{stackName}/lock.json`
   * file (e.g. for state-listing tools that don't yet know the region).
   */
  async getLockInfo(stackName: string, region: string | undefined): Promise<LockInfo | null> {
    await this.ensureClientForBucket();

    const key = this.getLockKey(stackName, region);

    try {
      this.logger.debug(`Getting lock info for stack: ${stackName}`);

      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
        })
      );

      if (!response.Body) {
        throw new LockError(`Lock file for stack '${stackName}' has no body`);
      }

      const bodyString = await response.Body.transformToString();
      const lockInfo = JSON.parse(bodyString) as LockInfo;

      this.logger.debug(`Lock info for stack: ${stackName}:`, lockInfo);

      return lockInfo;
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
   * Release a lock for a stack
   */
  async releaseLock(stackName: string, region: string): Promise<void> {
    await this.ensureClientForBucket();

    const key = this.getLockKey(stackName, region);

    try {
      this.logger.debug(`Releasing lock for stack: ${stackName} (${region})`);

      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
        })
      );

      this.logger.debug(`Lock released for stack: ${stackName} (${region})`);
    } catch (error) {
      throw new LockError(
        `Failed to release lock for stack '${stackName}' (${region}): ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
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
    const lockInfo = await this.getLockInfo(stackName, region);

    if (!lockInfo) {
      this.logger.warn(
        `No lock to force release for stack: ${stackName}${region ? ` (${region})` : ''}`
      );
      return;
    }

    this.logger.warn(
      `Force releasing lock for stack: ${stackName}${region ? ` (${region})` : ''}, ` +
        `owner: ${lockInfo.owner}` +
        `${lockInfo.operation ? `, operation: ${lockInfo.operation}` : ''}` +
        `, expired: ${this.isLockExpired(lockInfo)}`
    );

    await this.deleteLock(stackName, region);
  }

  /**
   * Internal method to delete the lock file from S3
   */
  private async deleteLock(stackName: string, region: string | undefined): Promise<void> {
    await this.ensureClientForBucket();

    const key = this.getLockKey(stackName, region);

    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      })
    );
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
