import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  NoSuchKey,
} from '@aws-sdk/client-s3';
import type { LockInfo } from '../types/state.js';
import type { StateBackendConfig } from '../types/config.js';
import { getLogger } from '../utils/logger.js';
import { LockError } from '../utils/error-handler.js';
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
 */
export class LockManager {
  private logger = getLogger().child('LockManager');
  private readonly ttlMs: number;

  constructor(
    private s3Client: S3Client,
    private config: StateBackendConfig,
    options?: LockManagerOptions
  ) {
    const ttlMinutes = options?.ttlMinutes ?? 30;
    this.ttlMs = ttlMinutes * 60 * 1000;
  }

  /**
   * Get the S3 key for a stack's lock file
   */
  private getLockKey(stackName: string): string {
    return `${this.config.prefix}/${stackName}/lock.json`;
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
      return `cdkq:${process.pid}`;
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
   * @param owner Lock owner identifier (defaults to user@hostname:pid)
   * @param operation Operation being performed (e.g., "deploy", "destroy")
   */
  async acquireLock(stackName: string, owner?: string, operation?: string): Promise<boolean> {
    const key = this.getLockKey(stackName);
    const lockOwner = owner || this.getDefaultOwner();
    const now = Date.now();

    const lockInfo: LockInfo = {
      owner: lockOwner,
      timestamp: now,
      expiresAt: now + this.ttlMs,
      ...(operation && { operation }),
    };

    try {
      this.logger.debug(`Attempting to acquire lock for stack: ${stackName}`);

      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: JSON.stringify(lockInfo, null, 2),
          ContentType: 'application/json',
          IfNoneMatch: '*', // Only succeed if object doesn't exist
        })
      );

      this.logger.debug(`Lock acquired for stack: ${stackName}, owner: ${lockOwner}`);
      return true;
    } catch (error) {
      // Check for PreconditionFailed error (S3 condition not met - lock already exists)
      const err = error as { name?: string };
      if (err.name === 'PreconditionFailed') {
        this.logger.debug(`Lock already exists for stack: ${stackName}`);

        // Check if the existing lock is expired
        const existingLock = await this.getLockInfo(stackName);
        if (existingLock && this.isLockExpired(existingLock)) {
          this.logger.info(
            `Expired lock detected for stack: ${stackName} (owner: ${existingLock.owner}, ` +
              `expired ${this.formatDuration(now - existingLock.expiresAt)} ago). Cleaning up...`
          );

          // Delete the expired lock and retry acquisition
          await this.deleteLock(stackName);

          // Retry once after cleaning up expired lock
          try {
            await this.s3Client.send(
              new PutObjectCommand({
                Bucket: this.config.bucket,
                Key: key,
                Body: JSON.stringify(lockInfo, null, 2),
                ContentType: 'application/json',
                IfNoneMatch: '*',
              })
            );

            this.logger.debug(
              `Lock acquired for stack: ${stackName} after expired lock cleanup, owner: ${lockOwner}`
            );
            return true;
          } catch (retryError) {
            const retryErr = retryError as { name?: string };
            if (retryErr.name === 'PreconditionFailed') {
              // Another process acquired the lock between our delete and retry
              this.logger.debug(
                `Lock was acquired by another process during expired lock cleanup for stack: ${stackName}`
              );
              return false;
            }
            throw retryError;
          }
        }

        return false;
      }

      throw new LockError(
        `Failed to acquire lock for stack '${stackName}': ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get current lock information
   */
  async getLockInfo(stackName: string): Promise<LockInfo | null> {
    const key = this.getLockKey(stackName);

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
      if (error instanceof NoSuchKey || (error as { name: string }).name === 'NoSuchKey') {
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
   * Release a lock for a stack
   */
  async releaseLock(stackName: string): Promise<void> {
    const key = this.getLockKey(stackName);

    try {
      this.logger.debug(`Releasing lock for stack: ${stackName}`);

      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
        })
      );

      this.logger.debug(`Lock released for stack: ${stackName}`);
    } catch (error) {
      throw new LockError(
        `Failed to release lock for stack '${stackName}': ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Force release a lock regardless of owner or expiry status
   *
   * This is intended for CLI usage (e.g., --force-unlock flag) when a lock
   * is stuck and needs manual intervention.
   */
  async forceReleaseLock(stackName: string): Promise<void> {
    const lockInfo = await this.getLockInfo(stackName);

    if (!lockInfo) {
      this.logger.warn(`No lock to force release for stack: ${stackName}`);
      return;
    }

    this.logger.warn(
      `Force releasing lock for stack: ${stackName}, owner: ${lockInfo.owner}` +
        `${lockInfo.operation ? `, operation: ${lockInfo.operation}` : ''}` +
        `, expired: ${this.isLockExpired(lockInfo)}`
    );

    await this.deleteLock(stackName);
  }

  /**
   * Internal method to delete the lock file from S3
   */
  private async deleteLock(stackName: string): Promise<void> {
    const key = this.getLockKey(stackName);

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
    owner?: string,
    operation?: string,
    maxRetries = 3,
    retryDelay = 2000
  ): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const acquired = await this.acquireLock(stackName, owner, operation);

      if (acquired) {
        return;
      }

      // Lock exists and is not expired - show info and possibly retry
      const lockInfo = await this.getLockInfo(stackName);

      if (lockInfo) {
        const remainingMs = lockInfo.expiresAt - Date.now();

        if (attempt < maxRetries) {
          this.logger.info(
            `Stack '${stackName}' is locked by ${lockInfo.owner}` +
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
    const lockInfo = await this.getLockInfo(stackName);
    const expiresIn = lockInfo ? this.formatDuration(lockInfo.expiresAt - Date.now()) : 'unknown';

    throw new LockError(
      `Failed to acquire lock for stack '${stackName}' after ${maxRetries + 1} attempts. ` +
        (lockInfo
          ? `Locked by: ${lockInfo.owner}` +
            `${lockInfo.operation ? `, operation: ${lockInfo.operation}` : ''}` +
            `, expires in: ${expiresIn}. ` +
            `Use --force-unlock to manually release the lock.`
          : 'Lock exists but could not read lock info.')
    );
  }
}
