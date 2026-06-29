import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * S3 cross-bucket replication whose rule uses a COMBINED filter (a prefix AND a
 * tag). CloudFormation / CDK express this only via the `Filter.And` operator:
 *
 *   Filter: { And: { Prefix: 'logs/', TagFilters: [{ Key, Value }] } }
 *
 * cdkd's S3 provider previously read only top-level `Filter.Prefix` /
 * `Filter.TagFilter` and never `Filter.And`, so a combined filter silently
 * collapsed to an empty `Filter: {}` and replicated EVERY object instead of the
 * prefix+tag subset (a silent scope-broadening divergence). This fixture proves
 * the And filter reaches AWS verbatim on CREATE and on an in-place UPDATE.
 *
 *   covers: AWS::S3::Bucket, AWS::IAM::Role
 *
 * The source bucket uses an L1 CfnBucket so the combined `Filter.And` shape is
 * authored exactly as CFn emits it. Phase 1 deploys with `Prefix: 'logs/'`;
 * Phase 2 (CDKD_TEST_UPDATE=true) changes it to `Prefix: 'data/'` (an in-place
 * PutBucketReplication UPDATE — no bucket replacement).
 */
export class S3ReplicationAndFilterStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const update = process.env.CDKD_TEST_UPDATE === 'true';
    const account = cdk.Stack.of(this).account;

    const srcName = `cdkd-repl-src-${account}`;
    const dstName = `cdkd-repl-dst-${account}`;

    // Destination bucket — replication requires versioning on both ends.
    const dst = new s3.CfnBucket(this, 'DestBucket', {
      bucketName: dstName,
      versioningConfiguration: { status: 'Enabled' },
    });
    dst.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Replication role assumed by S3.
    const role = new iam.Role(this, 'ReplicationRole', {
      assumedBy: new iam.ServicePrincipal('s3.amazonaws.com'),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetReplicationConfiguration', 's3:ListBucket'],
        resources: [`arn:aws:s3:::${srcName}`],
      })
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3:GetObjectVersionForReplication',
          's3:GetObjectVersionAcl',
          's3:GetObjectVersionTagging',
        ],
        resources: [`arn:aws:s3:::${srcName}/*`],
      })
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ReplicateObject', 's3:ReplicateDelete', 's3:ReplicateTags'],
        resources: [`arn:aws:s3:::${dstName}/*`],
      })
    );

    // Source bucket with a COMBINED And filter (prefix + tag).
    const src = new s3.CfnBucket(this, 'SourceBucket', {
      bucketName: srcName,
      versioningConfiguration: { status: 'Enabled' },
      replicationConfiguration: {
        role: role.roleArn,
        rules: [
          {
            id: 'combined-and-filter',
            status: 'Enabled',
            priority: 1,
            deleteMarkerReplication: { status: 'Disabled' },
            filter: {
              and: {
                prefix: update ? 'data/' : 'logs/',
                tagFilters: [{ key: 'replicate', value: 'yes' }],
              },
            },
            destination: { bucket: dst.attrArn },
          },
        ],
      },
    });
    src.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    src.node.addDependency(dst);
    src.node.addDependency(role);

    new cdk.CfnOutput(this, 'SourceBucketName', { value: srcName });
  }
}
