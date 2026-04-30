import { Option, Command } from 'commander';
import { commonOptions, deprecatedRegionOption, warnIfDeprecatedRegion } from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { AssetPublisher } from '../../assets/asset-publisher.js';

/**
 * Publish assets command implementation
 */
async function publishAssetsCommand(options: {
  path: string;
  verbose: boolean;
  region?: string;
  profile?: string;
  assetPublishConcurrency: number;
  imageBuildConcurrency: number;
}): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
  }

  // PR 5: --region is deprecated on non-bootstrap commands. Warn but keep
  // the rest of the pipeline working as before.
  warnIfDeprecatedRegion(options);

  logger.info('Publishing assets...');
  logger.debug('Asset manifest path:', options.path);

  const publisher = new AssetPublisher();

  await publisher.publishFromManifest(options.path, {
    ...(options.profile && { profile: options.profile }),
    ...(options.region && { region: options.region }),
    assetPublishConcurrency: options.assetPublishConcurrency,
    imageBuildConcurrency: options.imageBuildConcurrency,
  });

  logger.info('✅ Asset publishing complete');
}

/**
 * Create publish-assets command
 */
export function createPublishAssetsCommand(): Command {
  const cmd = new Command('publish-assets')
    .description('Publish assets to S3/ECR from asset manifest')
    .requiredOption('--path <path>', 'Path to asset manifest file or directory')
    .addOption(
      new Option(
        '--asset-publish-concurrency <number>',
        'Maximum concurrent asset publish operations'
      )
        .default(8)
        .argParser((value) => parseInt(value, 10))
    )
    .addOption(
      new Option('--image-build-concurrency <number>', 'Maximum concurrent Docker image builds')
        .default(4)
        .argParser((value) => parseInt(value, 10))
    )
    .action(withErrorHandling(publishAssetsCommand));

  // Add common options
  commonOptions.forEach((opt) => cmd.addOption(opt));

  // --region is deprecated for publish-assets (PR 5). Accepted for backward
  // compatibility; warning emitted at runtime via warnIfDeprecatedRegion.
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
