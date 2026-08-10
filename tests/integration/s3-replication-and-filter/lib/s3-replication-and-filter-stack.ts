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
    const logName = `cdkd-repl-log-${account}`;

    // Server-access-log target for the issue #1495 TargetObjectKeyFormat
    // assertion. It carries CDK's auto-delete-objects tag because S3 may
    // deliver a log object into it at any point after the run, and cdkd's
    // delete refuses a non-empty bucket without that opt-in (the same marker
    // `autoDeleteObjects: true` stamps) — see data-delete-intent.ts.
    const log = new s3.CfnBucket(this, 'LogBucket', {
      bucketName: logName,
      tags: [{ key: 'aws-cdk:auto-delete-objects', value: 'true' }],
    });
    log.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // S3 validates the target bucket's policy during PutBucketLogging, so the
    // policy has to exist before the source bucket is written.
    const logPolicy = new s3.CfnBucketPolicy(this, 'LogBucketPolicy', {
      bucket: logName,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'S3ServerAccessLogsPolicy',
            Effect: 'Allow',
            Principal: { Service: 'logging.s3.amazonaws.com' },
            Action: 's3:PutObject',
            Resource: `arn:aws:s3:::${logName}/access/*`,
            Condition: { StringEquals: { 'aws:SourceAccount': account } },
          },
        ],
      },
    });
    logPolicy.node.addDependency(log);

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
      // Issue #1495: the partitioned server-access-log key format. cdkd never
      // built `TargetObjectKeyFormat` at all, so a bucket declaring it got the
      // FLAT default and the deploy still reported success. Only a read-back
      // off the live bucket can prove delivery.
      loggingConfiguration: {
        destinationBucketName: logName,
        logFilePrefix: 'access/',
        targetObjectKeyFormat: { partitionedPrefix: { partitionDateSource: 'EventTime' } },
      },
      // Issue #1495: `TransitionDefaultMinimumObjectSize` sits on the
      // PutBucketLifecycleConfiguration REQUEST rather than inside
      // `LifecycleConfiguration`, which is exactly why the rules-only mapper
      // never reached it.
      //
      // The value is deliberately the NON-default one. AWS defaults buckets
      // created after September 2024 to `all_storage_classes_128K`, so
      // asserting THAT would pass even with the write removed — a vacuous
      // read-back, which is the trap this fixture exists to avoid.
      lifecycleConfiguration: {
        transitionDefaultMinimumObjectSize: 'varies_by_storage_class',
        rules: [{ id: 'expire-noncurrent', status: 'Enabled', expirationInDays: 30 }],
      },
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
            // Issue #1495: Replication Time Control. `ReplicationTime` and
            // `Metrics` were both dropped, so a template asking for the RTC SLA
            // got plain asynchronous replication with no error anywhere. AWS
            // requires the two together and only accepts 15 minutes.
            destination: {
              bucket: dst.attrArn,
              replicationTime: { status: 'Enabled', time: { minutes: 15 } },
              metrics: { status: 'Enabled', eventThreshold: { minutes: 15 } },
            },
            // Issue #1495: which SOURCE objects are eligible. Dropped, so the
            // rule replicated a different set of objects than declared.
            sourceSelectionCriteria: { replicaModifications: { status: 'Enabled' } },
          },
        ],
      },
    });
    src.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    src.node.addDependency(dst);
    src.node.addDependency(role);
    src.node.addDependency(logPolicy);

    new cdk.CfnOutput(this, 'SourceBucketName', { value: srcName });
  }
}
