import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * go-to-k/cdkd#4606, the S3 bucket arm: a fix-forward deploy deletes the
 * bucket a failed CREATE left in AWS, and keeps one whose name was re-used.
 *
 * - The baseline holds `BaseBucket` alone (a stack needs a resource).
 * - `WITH_ORPHANS=true` adds `OrphanA` and `OrphanC`, each with versioning
 *   enabled and the stack's tag. verify.sh deploys that template as a role
 *   that may create a bucket and enable its versioning but may neither tag
 *   nor delete it, so each CREATE makes the bucket, writes its versioning,
 *   fails on the tagging call, and cannot clean up: the journal records both
 *   as proven orphans, with the bucket's identity (name, region and this
 *   account's `ListBuckets` `CreationDate`, which outside us-east-1 the
 *   versioning write has already moved).
 * - `ORPHAN_FIX_FORWARD=true` keeps both logical ids under other names
 *   (`-b`), so the fix-forward deploy creates two new buckets. Before it,
 *   verify.sh deletes `OrphanC`'s bucket and re-creates the name itself (one
 *   made outside the stack): the fix-forward must delete `OrphanA`'s bucket
 *   and keep that one.
 *
 * L1 buckets with explicit names and only properties the S3 SDK provider
 * handles, so every bucket stays on the SDK route (`provisionedBy: sdk`),
 * where `isSameResource` / `resourceIdentity` live. The names carry the
 * account id: S3 names are global.
 */
export class S3FixForwardOrphanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 's3-fix-forward-orphan');
    const account = cdk.Stack.of(this).account;

    new s3.CfnBucket(this, 'BaseBucket', { bucketName: `cdkd-s3ffo-base-${account}` });

    if (process.env.WITH_ORPHANS === 'true') {
      const suffix = process.env.ORPHAN_FIX_FORWARD === 'true' ? '-b' : '';
      for (const [logicalId, stem] of [
        ['OrphanA', 'a'],
        ['OrphanC', 'c'],
      ] as const) {
        new s3.CfnBucket(this, logicalId, {
          bucketName: `cdkd-s3ffo-${stem}${suffix}-${account}`,
          versioningConfiguration: { status: 'Enabled' },
        });
      }
    }
  }
}
