import { Command } from 'commander';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutBucketEncryptionCommand,
  type BucketLocationConstraint,
} from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { commonOptions } from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling, normalizeAwsError } from '../../utils/error-handler.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { getDefaultStateBucketName } from '../config-loader.js';

/**
 * Bootstrap command implementation
 *
 * Creates S3 bucket for state management
 */
async function bootstrapCommand(options: {
  stateBucket?: string;
  region?: string;
  profile?: string;
  force: boolean;
  verbose: boolean;
}): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
  }

  logger.info('Starting cdkd bootstrap...');
  logger.debug('Options:', options);

  // Initialize AWS clients with region/profile
  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  const s3Client = awsClients.s3;
  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';

  // Resolve bucket name: use provided value or generate default from account info
  let bucketName: string;
  let accountId: string;

  if (options.stateBucket) {
    bucketName = options.stateBucket;
    // Still need accountId for bucket policy
    const identity = await awsClients.sts.send(new GetCallerIdentityCommand({}));
    accountId = identity.Account!;
  } else {
    logger.info('No --state-bucket specified, resolving default bucket name...');
    const identity = await awsClients.sts.send(new GetCallerIdentityCommand({}));
    accountId = identity.Account!;
    bucketName = getDefaultStateBucketName(accountId);
    logger.info(`Using default state bucket: ${bucketName}`);
  }

  try {
    // Check if bucket already exists.
    //
    // The HeadBucket pre-check is the same call site that produces the
    // AWS SDK v3 synthetic `UnknownError` when the bucket lives in a
    // different region than the client. Routing the error through
    // `normalizeAwsError` turns "UnknownError" into a concrete message
    // ("different region", "access denied", etc.).
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
        throw normalizeAwsError(error, { bucket: bucketName, operation: 'HeadBucket' });
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

    // Enable versioning
    logger.debug('Enabling bucket versioning...');
    await s3Client.send(
      new PutBucketVersioningCommand({
        Bucket: bucketName,
        VersioningConfiguration: {
          Status: 'Enabled',
        },
      })
    );
    logger.info('✓ Enabled bucket versioning');

    // Enable server-side encryption (AES-256)
    logger.debug('Enabling bucket encryption...');
    await s3Client.send(
      new PutBucketEncryptionCommand({
        Bucket: bucketName,
        ServerSideEncryptionConfiguration: {
          Rules: [
            {
              ApplyServerSideEncryptionByDefault: {
                SSEAlgorithm: 'AES256',
              },
              BucketKeyEnabled: true,
            },
          ],
        },
      })
    );
    logger.info('✓ Enabled bucket encryption (AES-256)');

    // Set bucket policy to deny external access
    logger.debug('Setting bucket policy...');
    const bucketPolicy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'DenyExternalAccess',
          Effect: 'Deny',
          Principal: '*',
          Action: 's3:*',
          Resource: [`arn:aws:s3:::${bucketName}`, `arn:aws:s3:::${bucketName}/*`],
          Condition: {
            StringNotEquals: {
              'aws:PrincipalAccount': accountId,
            },
          },
        },
      ],
    };

    await s3Client.send(
      new PutBucketPolicyCommand({
        Bucket: bucketName,
        Policy: JSON.stringify(bucketPolicy),
      })
    );
    logger.info('✓ Set bucket policy (deny external access)');

    logger.info('\n✓ Bootstrap completed successfully');
    logger.info(`\nState bucket: ${bucketName}`);
    logger.info(`Region: ${region}`);
    logger.info('\nYou can now use cdkd deploy with:');
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
    .description('Bootstrap cdkd by creating required S3 bucket for state management')
    .option(
      '--state-bucket <bucket>',
      'Name of S3 bucket to create for state storage (default: cdkd-state-{accountId})'
    )
    .option('--force', 'Force reconfiguration of existing bucket', false)
    .action(withErrorHandling(bootstrapCommand));

  // Add common options (includes --region, --profile, --verbose)
  commonOptions.forEach((opt) => cmd.addOption(opt));

  return cmd;
}
