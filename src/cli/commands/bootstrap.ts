import { Command, Option } from 'commander';
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutBucketEncryptionCommand,
  type BucketLocationConstraint,
} from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { ECRClient } from '@aws-sdk/client-ecr';
import { commonOptions } from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling, normalizeAwsError } from '../../utils/error-handler.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { getDefaultStateBucketName } from '../config-loader.js';
import { ensureAssetStorage } from '../../assets/asset-storage.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';

/**
 * Bootstrap command implementation
 *
 * Creates the S3 bucket for state management and (unless --no-assets) the
 * cdkd-owned asset storage for the region: asset bucket + container-asset
 * ECR repo + the per-region bootstrap marker that flips deploys in this
 * region from legacy (CDK bootstrap destinations) to cdkd-assets mode
 * (issue #1002, design at docs/design/1002-cdkd-asset-storage.md).
 */
async function bootstrapCommand(options: {
  stateBucket?: string;
  region?: string;
  profile?: string;
  roleArn?: string;
  force: boolean;
  assets: boolean;
  verbose: boolean;
}): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
  }

  logger.info('Starting cdkd bootstrap...');
  logger.debug('Options:', options);

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call.
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

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

    // Skip the state-bucket configuration PUTs (versioning / encryption /
    // policy) when the bucket already exists and --force was not passed.
    // Unlike the pre-#1002 flow this no longer returns early — the asset
    // storage step below must still run so an existing user can opt a
    // region into cdkd-assets mode by simply re-running bootstrap.
    let skipStateBucketConfig = false;
    if (bucketExists) {
      if (!options.force) {
        if (!options.assets) {
          logger.warn(
            `Bucket ${bucketName} already exists. Use --force to reconfigure (this will not delete existing state)`
          );
          return;
        }
        logger.info(
          `State bucket ${bucketName} already exists — skipping reconfiguration (use --force to reconfigure)`
        );
        skipStateBucketConfig = true;
      } else {
        logger.info('--force specified, continuing with existing bucket');
      }
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

    if (!skipStateBucketConfig) {
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
    }

    // cdkd-owned asset storage (issue #1002): asset bucket + container-asset
    // ECR repo + the per-region bootstrap marker. Skipped under --no-assets
    // (explicit opt-out for users who want to keep CDK bootstrap storage,
    // e.g. custom-synthesizer users).
    let assetStorage: { assetBucket: string; containerRepo: string } | undefined;
    if (options.assets) {
      logger.info('\nSetting up cdkd asset storage...');
      const ecrClient = new ECRClient({
        region,
        ...(options.profile && { profile: options.profile }),
      });
      // The marker lives in the state bucket, which may be in a different
      // region than --region (the state bucket is account-scoped and
      // single-region). S3StateBackend resolves the bucket's actual region
      // before the write — it OWNS (and may destroy/rebuild) its client, so
      // it gets a dedicated one instead of sharing awsClients.s3. The
      // `prefix` is irrelevant here (the marker is written via prefix-free
      // putRawObject) but the constructor requires one.
      const markerS3Client = new S3Client({
        region,
        ...(options.profile && { profile: options.profile }),
      });
      const stateBackend = new S3StateBackend(
        markerS3Client,
        { bucket: bucketName, prefix: 'cdkd' },
        { region, ...(options.profile && { profile: options.profile }) }
      );
      try {
        assetStorage = await ensureAssetStorage({
          s3Client,
          ecrClient,
          stateBackend,
          accountId,
          region,
          force: options.force,
        });
      } finally {
        ecrClient.destroy();
        // If the backend rebuilt its client for the state bucket's region it
        // already destroyed this one; a second destroy is a safe no-op.
        markerS3Client.destroy();
      }
    } else {
      logger.info(
        '\n--no-assets specified — skipping cdkd asset storage. Deploys in this region ' +
          'keep publishing assets to the CDK bootstrap bucket/repo.'
      );
    }

    logger.info('\n✓ Bootstrap completed successfully');
    logger.info(`\nState bucket: ${bucketName}`);
    if (assetStorage) {
      logger.info(`Asset bucket: ${assetStorage.assetBucket}`);
      logger.info(`Container-asset repository: ${assetStorage.containerRepo}`);
    }
    logger.info(`Region: ${region}`);
    if (assetStorage) {
      logger.info(
        `\ncdkd asset storage is now ON for region ${region}: deploys in this region ` +
          `publish assets to the cdkd-owned bucket/repo (out of 'cdk gc' reach) instead ` +
          `of the CDK bootstrap storage. The first deploy of each existing stack with ` +
          `assets will show a one-time UPDATE re-pointing asset references — content is ` +
          `identical, no replacement.`
      );
    }
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
    .description(
      'Bootstrap cdkd by creating the S3 state bucket plus cdkd-owned asset storage ' +
        '(asset bucket + container-asset ECR repo) for the region'
    )
    .option(
      '--state-bucket <bucket>',
      'Name of S3 bucket to create for state storage (default: cdkd-state-{accountId})'
    )
    .option('--force', 'Force reconfiguration of existing bucket', false)
    .option(
      '--no-assets',
      'Skip cdkd asset storage (asset bucket / ECR repo / marker) — deploys keep ' +
        'publishing assets to the CDK bootstrap bucket/repo'
    )
    .addOption(
      // Bootstrap-specific: needs to know which region to create the bucket
      // in. After PR 5, `--region` is removed from `commonOptions` and only
      // re-added explicitly here — every other command resolves the region
      // from `AWS_REGION` / profile.
      new Option(
        '--region <region>',
        'AWS region in which to create the state bucket (defaults to AWS_REGION env or us-east-1)'
      )
    )
    .action(withErrorHandling(bootstrapCommand));

  // Add common options (--profile, --verbose, --yes)
  commonOptions.forEach((opt) => cmd.addOption(opt));

  return cmd;
}
