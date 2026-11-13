import {
  CreateBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  type BucketLocationConstraint,
  type S3Client,
} from '@aws-sdk/client-s3';

import { getLogger } from '../../utils/logger.js';
import { buildDenyExternalAccessPolicy } from '../../utils/deny-external-access-policy.js';
import {
  applyCustomResourceResponseExpiration,
  customResourceResponseExpirationWarning,
  CUSTOM_RESOURCE_RESPONSE_EXPIRATION_DAYS,
  CUSTOM_RESOURCE_RESPONSE_LIFECYCLE_RULE_ID,
} from '../../state/state-bucket-lifecycle.js';
import { CUSTOM_RESOURCE_RESPONSE_PREFIX } from '../../state/state-prefix.js';
import { safeMsg } from '../../utils/display-safe.js';

/**
 * The state-bucket half of `cdkd bootstrap`, shared with the `--aws-emulator`
 * auto-bootstrap of `cdkd deploy` / `cdkd import` (go-to-k/cdkd#6186) so both
 * create and configure the bucket the same way.
 *
 * `report` receives the progress lines (`cdkd bootstrap` prints them at info;
 * the auto-bootstrap prints one summary line of its own and these at debug).
 * Warnings always go to the logger's warn.
 */
export interface StateBucketSetupArgs {
  /** The client that creates and configures the bucket. */
  s3: S3Client;
  bucketName: string;
  accountId: string;
  /** The region the bucket is created in (its `LocationConstraint`). */
  region: string;
  report: (message: string) => void;
}

/** `CreateBucket`, with the `LocationConstraint` every region but us-east-1 needs. */
export async function createStateBucket(args: StateBucketSetupArgs): Promise<void> {
  const { s3, bucketName, region, report } = args;
  report(`Creating S3 bucket: ${bucketName} in region ${region}`);

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

  await s3.send(new CreateBucketCommand(createBucketParams));
  report(`✓ Created S3 bucket: ${bucketName}`);
}

/**
 * Versioning, AES-256 encryption, the deny-external-access policy and the
 * custom-resource response lifecycle rule.
 */
export async function configureStateBucket(args: StateBucketSetupArgs): Promise<void> {
  const { s3, bucketName, accountId, report } = args;
  const logger = getLogger();

  // Enable versioning
  logger.debug('Enabling bucket versioning...');
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: bucketName,
      ExpectedBucketOwner: accountId,
      VersioningConfiguration: {
        Status: 'Enabled',
      },
    })
  );
  report('✓ Enabled bucket versioning');

  // Enable server-side encryption (AES-256)
  logger.debug('Enabling bucket encryption...');
  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket: bucketName,
      ExpectedBucketOwner: accountId,
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
  report('✓ Enabled bucket encryption (AES-256)');

  // Set bucket policy to deny external access.
  //
  // The partition comes from the CLIENT that writes the policy, never from
  // the caller's `region` value. That value can fall back to a HARDCODED
  // `us-east-1`, while a region-less client lets the SDK chain resolve it —
  // which reads `~/.aws/config`'s profile region and `AWS_DEFAULT_REGION`.
  // So a GovCloud / China user with `region = us-gov-west-1` in their profile
  // and no `AWS_REGION` would get partition `aws` -> an inert deny on an
  // `aws-us-gov` bucket: issue #1794's exact failure mode. The client is
  // authoritative either way: on the existing-bucket path it is the client
  // region-corrected FOR this bucket, and on the first-time path it is the
  // client that CREATED the bucket — so the bucket is in its partition by
  // construction.
  logger.debug('Setting bucket policy...');
  const bucketPolicy = buildDenyExternalAccessPolicy(
    bucketName,
    accountId,
    await s3.config.region()
  );

  await s3.send(
    new PutBucketPolicyCommand({
      Bucket: bucketName,
      ExpectedBucketOwner: accountId,
      Policy: JSON.stringify(bucketPolicy),
    })
  );
  report('✓ Set bucket policy (deny external access)');

  // Issue #2353: expire custom-resource response objects after one day.
  // A read-merge-write that keeps every existing lifecycle rule, and a
  // warning rather than a failure when it cannot run: a bootstrap that
  // used to succeed without the lifecycle permissions still succeeds.
  // Buckets bootstrapped before this get the rule from their first
  // custom-resource deploy instead (`CustomResourceProvider`).
  logger.debug('Setting custom-resource response lifecycle rule...');
  const lifecycle = await applyCustomResourceResponseExpiration(s3, bucketName, {
    expectedBucketOwner: accountId,
  });
  if (lifecycle.status === 'failed' || lifecycle.status === 'refused') {
    logger.warn(customResourceResponseExpirationWarning(bucketName, lifecycle));
  } else if (lifecycle.status === 'added') {
    report(
      safeMsg`✓ Set lifecycle rule (expire ${CUSTOM_RESOURCE_RESPONSE_PREFIX}/ responses after ${CUSTOM_RESOURCE_RESPONSE_EXPIRATION_DAYS} day)`
    );
  } else {
    report(
      safeMsg`✓ Lifecycle rule ${CUSTOM_RESOURCE_RESPONSE_LIFECYCLE_RULE_ID} already present (left unchanged)`
    );
  }
}
