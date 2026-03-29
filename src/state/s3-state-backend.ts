import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
} from '@aws-sdk/client-s3';
import type { StackState } from '../types/state.js';
import type { StateBackendConfig } from '../types/config.js';
import { getLogger } from '../utils/logger.js';
import { StateError } from '../utils/error-handler.js';

/**
 * S3-based state backend using conditional writes for optimistic locking
 */
export class S3StateBackend {
  private logger = getLogger().child('S3StateBackend');

  constructor(
    private s3Client: S3Client,
    private config: StateBackendConfig
  ) {}

  /**
   * Get the S3 key for a stack's state file
   */
  private getStateKey(stackName: string): string {
    return `${this.config.prefix}/${stackName}/state.json`;
  }

  /**
   * Check if state exists for a stack
   */
  async stateExists(stackName: string): Promise<boolean> {
    const key = this.getStateKey(stackName);

    try {
      await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
        })
      );
      return true;
    } catch (error) {
      if (error instanceof NoSuchKey || (error as { name: string }).name === 'NotFound') {
        return false;
      }
      throw new StateError(
        `Failed to check if state exists for stack '${stackName}': ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get state for a stack
   *
   * Note: S3 returns ETag with surrounding quotes (e.g., "abc123").
   * We preserve the quotes as they are required for IfMatch conditions.
   */
  async getState(stackName: string): Promise<{ state: StackState; etag: string } | null> {
    const key = this.getStateKey(stackName);

    try {
      this.logger.debug(`Getting state for stack: ${stackName}`);

      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
        })
      );

      if (!response.Body) {
        throw new StateError(`State file for stack '${stackName}' has no body`);
      }

      if (!response.ETag) {
        throw new StateError(`State file for stack '${stackName}' has no ETag`);
      }

      const bodyString = await response.Body.transformToString();
      const state = JSON.parse(bodyString) as StackState;

      this.logger.debug(`Retrieved state for stack: ${stackName}, ETag: ${response.ETag}`);

      // ETag is returned with quotes (e.g., "abc123") which is required for IfMatch
      return {
        state,
        etag: response.ETag,
      };
    } catch (error) {
      if (error instanceof NoSuchKey || (error as { name: string }).name === 'NoSuchKey') {
        this.logger.debug(`No existing state for stack: ${stackName}`);
        return null;
      }

      if (error instanceof StateError) {
        throw error;
      }

      throw new StateError(
        `Failed to get state for stack '${stackName}': ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Save state for a stack with optimistic locking
   *
   * @param stackName Stack name
   * @param state State to save
   * @param expectedEtag Expected ETag for optimistic locking (optional for new state).
   *                     Must include quotes if provided (e.g., "abc123")
   * @returns New ETag (with quotes, e.g., "abc123")
   */
  async saveState(stackName: string, state: StackState, expectedEtag?: string): Promise<string> {
    const key = this.getStateKey(stackName);

    try {
      this.logger.debug(
        `Saving state for stack: ${stackName}${expectedEtag ? `, expected ETag: ${expectedEtag}` : ''}`
      );

      const body = JSON.stringify(state, null, 2);
      const response = await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ContentLength: Buffer.byteLength(body),
          ContentType: 'application/json',
          ...(expectedEtag && { IfMatch: expectedEtag }),
        })
      );

      if (!response.ETag) {
        throw new StateError(`No ETag returned after saving state for stack '${stackName}'`);
      }

      this.logger.debug(`State saved for stack: ${stackName}, new ETag: ${response.ETag}`);

      return response.ETag;
    } catch (error) {
      if ((error as { name: string }).name === 'PreconditionFailed') {
        throw new StateError(
          `State has been modified by another process. Expected ETag: ${expectedEtag}, but state has changed.`
        );
      }

      throw new StateError(
        `Failed to save state for stack '${stackName}': ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Delete state for a stack
   */
  async deleteState(stackName: string): Promise<void> {
    const key = this.getStateKey(stackName);

    try {
      this.logger.debug(`Deleting state for stack: ${stackName}`);

      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
        })
      );

      this.logger.debug(`State deleted for stack: ${stackName}`);
    } catch (error) {
      throw new StateError(
        `Failed to delete state for stack '${stackName}': ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * List all stacks with state
   */
  async listStacks(): Promise<string[]> {
    try {
      this.logger.debug('Listing all stacks');

      const response = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: `${this.config.prefix}/`,
          Delimiter: '/',
        })
      );

      if (!response.CommonPrefixes) {
        return [];
      }

      // Extract stack names from prefixes
      // Prefix format: "{prefix}/{stackName}/"
      const stackNames = response.CommonPrefixes.map((prefix) => {
        const prefixStr = prefix.Prefix || '';
        const parts = prefixStr.split('/');
        // Get the second-to-last part (stack name)
        return parts[parts.length - 2];
      }).filter((name): name is string => Boolean(name));

      this.logger.debug(`Found ${stackNames.length} stacks`);

      return stackNames;
    } catch (error) {
      throw new StateError(
        `Failed to list stacks: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }
}
