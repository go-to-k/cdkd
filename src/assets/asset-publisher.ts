import {
  AssetManifest,
  AssetPublishing,
  DefaultAwsClient,
  EventType,
  type IPublishProgressListener,
} from '@aws-cdk/cdk-assets-lib';
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

  /** Whether to build assets */
  buildAssets?: boolean;

  /** Whether to publish assets */
  publishAssets?: boolean;

  /** Whether to publish in parallel */
  publishInParallel?: boolean;
}

/**
 * Asset publisher using cdk-assets library
 */
export class AssetPublisher {
  private logger = getLogger().child('AssetPublisher');

  /**
   * Publish assets from asset manifest file
   */
  async publishFromManifest(
    manifestPath: string,
    options: AssetPublisherOptions = {}
  ): Promise<void> {
    try {
      this.logger.info('Loading asset manifest:', manifestPath);

      // Load asset manifest
      const manifest = AssetManifest.fromPath(manifestPath);

      this.logger.debug('Manifest directory:', manifest.directory);
      this.logger.debug('Assets to publish:', manifest.entries.length);

      // Create AWS client (profile only, region is handled by AWS SDK defaults)
      const aws = new DefaultAwsClient(options.profile);

      // Set region via environment variable if specified
      if (options.region) {
        process.env['AWS_REGION'] = options.region;
      }

      // Create progress listener
      const progressListener: IPublishProgressListener = {
        onPublishEvent: (type, event) => {
          if (type === EventType.START) {
            this.logger.info(`Publishing asset: ${event.message || 'unknown'}`);
          } else if (type === EventType.SUCCESS) {
            this.logger.info(`✅ Published: ${event.message || 'unknown'}`);
          } else if (type === EventType.FAIL) {
            this.logger.error(`❌ Failed: ${event.message || 'unknown'}`);
          }
        },
      };

      // Create asset publisher
      const publisher = new AssetPublishing(manifest, {
        aws,
        progressListener,
        publishInParallel: options.publishInParallel ?? false,
        throwOnError: true,
      });

      // Publish all assets
      this.logger.info('Publishing assets...');
      await publisher.publish();

      this.logger.info('✅ All assets published successfully');
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
      const manifest = AssetManifest.fromPath(manifestPath);
      return manifest.entries.length > 0;
    } catch (error) {
      this.logger.warn('Failed to check assets:', error);
      return false;
    }
  }
}
