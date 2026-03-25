import { Command } from 'commander';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  type BucketLocationConstraint,
} from '@aws-sdk/client-s3';
import { commonOptions } from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';

/**
 * Bootstrap command implementation
 *
 * Creates S3 bucket for state management
 */
async function bootstrapCommand(options: {
  stateBucket: string;
  region?: string;
  profile?: string;
  force: boolean;
  verbose: boolean;
}): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
  }

  logger.info('Starting cdkq bootstrap...');
  logger.debug('Options:', options);

  // Initialize AWS clients with region/profile
  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  const s3Client = awsClients.s3;
  const bucketName = options.stateBucket;
  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';

  try {
    // Check if bucket already exists
    let bucketExists = false;
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
      bucketExists = true;
      logger.info(`Bucket ${bucketName} already exists`);
    } catch (error) {
      const err = error as { name?: string };
      if (err.name === 'NotFound' || err.name === 'NoSuchBucket') {
        logger.debug(`Bucket ${bucketName} does not exist, will create`);
      } else {
        throw error;
      }
    }

    if (bucketExists) {
      if (!options.force) {
        logger.warn(
          `Bucket ${bucketName} already exists. Use --force to reconfigure (this will not delete existing state)`
        );
        return;
      }
      logger.info('--force specified, continuing with existing bucket');
    } else {
      // Create bucket
      logger.info(`Creating S3 bucket: ${bucketName} in region ${region}`);

      const createBucketParams: {
        Bucket: string;
        CreateBucketConfiguration?: {
          LocationConstraint: BucketLocationConstraint;
        };
      } = {
        Bucket: bucketName,
      };

      // For regions other than us-east-1, LocationConstraint is required
      if (region !== 'us-east-1') {
        createBucketParams.CreateBucketConfiguration = {
          LocationConstraint: region as BucketLocationConstraint,
        };
      }

      await s3Client.send(new CreateBucketCommand(createBucketParams));
      logger.info(`✓ Created S3 bucket: ${bucketName}`);
    }

    // TODO: Configure bucket settings
    // - Enable versioning
    // - Enable encryption
    // - Set bucket policy
    // - Set lifecycle rules

    logger.info('\n✓ Bootstrap completed successfully');
    logger.info(`\nState bucket: ${bucketName}`);
    logger.info(`Region: ${region}`);
    logger.info('\nYou can now use cdkq deploy with:');
    logger.info(`  --state-bucket ${bucketName}`);
    logger.info(`  --region ${region}`);
  } finally {
    awsClients.destroy();
  }
}

/**
 * Create bootstrap command
 */
export function createBootstrapCommand(): Command {
  const cmd = new Command('bootstrap')
    .description('Bootstrap cdkq by creating required S3 bucket for state management')
    .requiredOption('--state-bucket <bucket>', 'Name of S3 bucket to create for state storage')
    .option('--force', 'Force reconfiguration of existing bucket', false)
    .action(withErrorHandling(bootstrapCommand));

  // Add common options (includes --region, --profile, --verbose)
  commonOptions.forEach((opt) => cmd.addOption(opt));

  return cmd;
}
