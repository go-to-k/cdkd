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
 * S3-based lock manager using conditional writes (If-None-Match)
 *
 * Implements distributed locking using S3's If-None-Match: "*" condition
 * which ensures atomic lock acquisition
 */
export class LockManager {
  private logger = getLogger().child('LockManager');
  private readonly lockTTL = 15 * 60 * 1000; // 15 minutes

  constructor(
    private s3Client: S3Client,
    private config: StateBackendConfig
  ) {}

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
   * Try to acquire a lock for a stack
   *
   * Uses If-None-Match: "*" to ensure atomic lock acquisition.
   * Returns true if lock was acquired, false if already locked.
   *
   * @param stackName Stack name
   * @param owner Lock owner identifier (defaults to user@hostname:pid)
   * @param operation Operation being performed (e.g., "deploy", "destroy")
   */
  async acquireLock(stackName: string, owner?: string, operation?: string): Promise<boolean> {
    const key = this.getLockKey(stackName);
    const lockOwner = owner || this.getDefaultOwner();

    const lockInfo: LockInfo = {
      owner: lockOwner,
      timestamp: Date.now(),
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

      this.logger.info(`Lock acquired for stack: ${stackName}, owner: ${lockOwner}`);
      return true;
    } catch (error) {
      // TODO: Use proper AWS SDK v3 error type checking instead of name comparison
      // Should use: import { PreconditionFailedException } from '@aws-sdk/client-s3'
      // and check: error instanceof PreconditionFailedException
      if ((error as { name: string }).name === 'PreconditionFailed') {
        this.logger.debug(`Lock already exists for stack: ${stackName}`);
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

      this.logger.info(`Lock released for stack: ${stackName}`);
    } catch (error) {
      throw new LockError(
        `Failed to release lock for stack '${stackName}': ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Force release a lock (use with caution)
   *
   * This should only be used when a lock is stale (e.g., process crashed)
   */
  async forceReleaseLock(stackName: string): Promise<void> {
    const lockInfo = await this.getLockInfo(stackName);

    if (!lockInfo) {
      this.logger.warn(`No lock to force release for stack: ${stackName}`);
      return;
    }

    // Check if lock is stale (older than TTL)
    const age = Date.now() - lockInfo.timestamp;
    if (age < this.lockTTL) {
      throw new LockError(
        `Cannot force release a fresh lock. Lock age: ${Math.floor(age / 1000)}s, TTL: ${Math.floor(this.lockTTL / 1000)}s`
      );
    }

    this.logger.warn(
      `Force releasing stale lock for stack: ${stackName}, owner: ${lockInfo.owner}, age: ${Math.floor(age / 1000)}s`
    );

    await this.releaseLock(stackName);
  }

  /**
   * Acquire lock with retry logic
   *
   * @param stackName Stack name
   * @param owner Lock owner identifier
   * @param operation Operation being performed
   * @param maxRetries Maximum number of retries
   * @param retryDelay Delay between retries in milliseconds
   */
  async acquireLockWithRetry(
    stackName: string,
    owner?: string,
    operation?: string,
    maxRetries = 3,
    retryDelay = 5000
  ): Promise<void> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const acquired = await this.acquireLock(stackName, owner, operation);

      if (acquired) {
        return;
      }

      // Lock already exists, check if it's stale
      const lockInfo = await this.getLockInfo(stackName);

      if (lockInfo) {
        const age = Date.now() - lockInfo.timestamp;

        if (age >= this.lockTTL) {
          // Lock is stale, force release and retry
          this.logger.warn(
            `Stale lock detected for stack: ${stackName}, forcing release (age: ${Math.floor(age / 1000)}s)`
          );
          await this.forceReleaseLock(stackName);
          continue;
        }

        // Lock is fresh, wait and retry
        if (attempt < maxRetries - 1) {
          this.logger.info(
            `Stack ${stackName} is locked by ${lockInfo.owner}, waiting ${retryDelay}ms... (attempt ${attempt + 1}/${maxRetries})`
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          continue;
        }
      }
    }

    // Failed to acquire lock after all retries
    const lockInfo = await this.getLockInfo(stackName);
    throw new LockError(
      `Failed to acquire lock for stack '${stackName}' after ${maxRetries} attempts. ` +
        (lockInfo
          ? `Locked by: ${lockInfo.owner}${lockInfo.operation ? `, operation: ${lockInfo.operation}` : ''}`
          : 'Lock exists but could not read lock info.')
    );
  }
}
