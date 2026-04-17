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

  /** Whether to publish in parallel */
  publishInParallel?: boolean;
}

/**
 * Asset publisher
 *
 * Orchestrates file and Docker image asset publishing.
 * Replaces @aws-cdk/cdk-assets-lib with self-implemented publishers.
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

      // Count assets
      const fileAssets = Object.entries(manifest.files || {}).filter(
        ([, asset]) =>
          !asset.source.path.endsWith('.json') &&
          !asset.source.path.endsWith('.template.json')
      );
      const dockerAssets = Object.entries(manifest.dockerImages || {});
      const totalAssets = fileAssets.length + dockerAssets.length;

      if (totalAssets === 0) {
        this.logger.debug('No assets to publish');
        return;
      }

      this.logger.debug(`Assets to publish: ${fileAssets.length} files, ${dockerAssets.length} docker images`);

      // Publish file assets
      for (const [hash, asset] of fileAssets) {
        this.logger.debug(`Publishing file asset: ${asset.displayName || hash}`);
        await this.filePublisher.publish(
          hash,
          asset,
          cdkOutputDir,
          accountId,
          region,
          options.profile
        );
      }

      // Publish Docker image assets
      for (const [hash, asset] of dockerAssets) {
        this.logger.debug(`Publishing Docker image: ${asset.displayName || hash}`);
        await this.dockerPublisher.publish(
          hash,
          asset,
          cdkOutputDir,
          accountId,
          region,
          options.profile
        );
      }

      this.logger.debug('✅ All assets published successfully');
    } catch (error) {
      if (error instanceof AssetError) {
        throw error;
      }
      throw new AssetError(
        `Asset publishing failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
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
