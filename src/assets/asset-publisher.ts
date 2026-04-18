import { readFileSync } from 'node:fs';
import { FileAssetPublisher } from './file-asset-publisher.js';
import { DockerAssetPublisher } from './docker-asset-publisher.js';
import type { AssetManifest } from '../types/assets.js';
import { getLogger } from '../utils/logger.js';
import { AssetError } from '../utils/error-handler.js';

/**
 * Asset publishing options
 */
export interface AssetPublisherOptions {
  /** AWS profile to use */
  profile?: string;

  /** AWS region */
  region?: string;

  /** AWS account ID */
  accountId?: string;

  /**
   * Concurrency for file asset publishing (I/O bound).
   * Default: 8
   */
  filePublishConcurrency?: number;

  /**
   * Concurrency for Docker image builds (CPU/memory bound).
   * Default: 4
   */
  imageBuildConcurrency?: number;
}

/**
 * Asset publisher
 *
 * Orchestrates file and Docker image asset publishing with parallelization.
 * - File publish: 8 concurrent uploads (I/O bound)
 * - Docker build+push: 4 concurrent (CPU/memory bound)
 */
export class AssetPublisher {
  private logger = getLogger().child('AssetPublisher');
  private filePublisher = new FileAssetPublisher();
  private dockerPublisher = new DockerAssetPublisher();

  /**
   * Publish assets from asset manifest file
   */
  async publishFromManifest(
    manifestPath: string,
    options: AssetPublisherOptions = {}
  ): Promise<void> {
    try {
      this.logger.debug('Loading asset manifest:', manifestPath);

      // Load and parse manifest
      const content = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(content) as AssetManifest;

      // Determine cdkOutputDir from manifest path
      const cdkOutputDir = manifestPath.replace(/\/[^/]+$/, '');

      // Resolve account and region
      const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
      let accountId = options.accountId;

      if (!accountId) {
        // Resolve from STS
        const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
        const stsClient = new STSClient({ region });
        const identity = await stsClient.send(new GetCallerIdentityCommand({}));
        accountId = identity.Account!;
        stsClient.destroy();
      }

      // Collect assets
      const fileAssets = Object.entries(manifest.files || {}).filter(
        ([, asset]) =>
          !asset.source.path.endsWith('.json') && !asset.source.path.endsWith('.template.json')
      );
      const dockerAssets = Object.entries(manifest.dockerImages || {});
      const totalAssets = fileAssets.length + dockerAssets.length;

      if (totalAssets === 0) {
        this.logger.debug('No assets to publish');
        return;
      }

      this.logger.debug(
        `Assets to publish: ${fileAssets.length} files, ${dockerAssets.length} docker images`
      );

      const fileConcurrency = options.filePublishConcurrency ?? 8;
      const dockerConcurrency = options.imageBuildConcurrency ?? 4;

      // Publish file assets in parallel (I/O bound, high concurrency)
      if (fileAssets.length > 0) {
        await this.runWithConcurrency(
          fileAssets,
          async ([hash, asset]) => {
            this.logger.debug(`Publishing file asset: ${asset.displayName || hash}`);
            await this.filePublisher.publish(
              hash,
              asset,
              cdkOutputDir,
              accountId,
              region,
              options.profile
            );
          },
          fileConcurrency
        );
      }

      // Build and publish Docker images in parallel (CPU/memory bound, lower concurrency)
      if (dockerAssets.length > 0) {
        await this.runWithConcurrency(
          dockerAssets,
          async ([hash, asset]) => {
            this.logger.debug(`Publishing Docker image: ${asset.displayName || hash}`);
            await this.dockerPublisher.publish(
              hash,
              asset,
              cdkOutputDir,
              accountId,
              region,
              options.profile
            );
          },
          dockerConcurrency
        );
      }

      this.logger.debug('✅ All assets published successfully');
    } catch (error) {
      if (error instanceof AssetError) {
        throw error;
      }
      // Extract detailed error information from AWS SDK errors
      const err = error as Record<string, unknown>;
      const message = String(err['message'] || err['name'] || error);
      const code = String(err['Code'] || err['code'] || err['name'] || '');
      const detail = code ? `${code}: ${message}` : message;
      throw new AssetError(
        `Asset publishing failed: ${detail}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Run tasks with bounded concurrency
   */
  private async runWithConcurrency<T>(
    items: T[],
    fn: (item: T) => Promise<void>,
    concurrency: number
  ): Promise<void> {
    if (items.length === 0) return;

    // For single item or concurrency 1, run sequentially
    if (items.length === 1 || concurrency <= 1) {
      for (const item of items) {
        await fn(item);
      }
      return;
    }

    const errors: Error[] = [];
    let index = 0;

    const runNext = async (): Promise<void> => {
      while (index < items.length) {
        const currentIndex = index++;
        try {
          await fn(items[currentIndex]!);
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
          // Continue processing remaining items to avoid partial state
        }
      }
    };

    // Start up to `concurrency` workers
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runNext());
    await Promise.all(workers);

    if (errors.length > 0) {
      if (errors.length === 1) {
        throw errors[0];
      }
      throw new AssetError(
        `${errors.length} asset(s) failed to publish:\n${errors.map((e) => `  - ${e.message}`).join('\n')}`,
        errors[0]
      );
    }
  }

  /**
   * Check if assets need to be published
   */
  hasAssets(manifestPath: string): boolean {
    try {
      const content = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(content) as AssetManifest;
      const fileCount = Object.keys(manifest.files || {}).length;
      const dockerCount = Object.keys(manifest.dockerImages || {}).length;
      return fileCount + dockerCount > 0;
    } catch {
      this.logger.warn('Failed to check assets');
      return false;
    }
  }
}
