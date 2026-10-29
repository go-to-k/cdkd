import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3express from 'aws-cdk-lib/aws-s3express';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';

export class S3DirectoryBucketStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // go-to-k/cdkd#2007 (Phase 5): ONLY a directory bucket whose name is built
    // from a Secrets Manager secret, `<secret>--<az id>--x-s3`. Each phase
    // gives it an object, then deletes it through one delete site: a destroy,
    // a rollback (S3DIR_FAIL=true adds RollbackBreaker, which SSM refuses
    // after the bucket's create), or a deploy that drops it (S3DIR_DROP=true).
    // That delete's not-empty refusal must not print an `aws s3 rm` for it.
    const secretName = process.env.S3DIR_SECRET_NAME;
    if (secretName) {
      if (process.env.S3DIR_DROP === 'true') {
        // Something for the dropped bucket's stack to keep.
        new cdk.CfnWaitConditionHandle(this, 'KeepAlive');
        return;
      }
      const azId = process.env.S3DIR_AZ_ID ?? 'use1-az4';
      const secretBucket = new s3express.CfnDirectoryBucket(this, 'SecretNamedBucket', {
        bucketName: cdk.Fn.join('', [
          cdk.SecretValue.secretsManager(secretName).unsafeUnwrap(),
          `--${azId}--x-s3`,
        ]),
        dataRedundancy: 'SingleAvailabilityZone',
        locationName: `${this.region}c--x-s3`,
      });
      if (process.env.S3DIR_FAIL === 'true') {
        const breaker = new ssm.CfnParameter(this, 'RollbackBreaker', {
          type: 'String',
          tier: 'Standard',
          value: 'x'.repeat(5000),
        });
        breaker.addDependency(secretBucket);
      }
      return;
    }

    // S3 Express Directory Bucket WITHOUT the auto-delete opt-in: the
    // destroy data guard (issue #1344) must refuse to delete it while it
    // holds an out-of-band object.
    const bucket = new s3express.CfnDirectoryBucket(this, 'DirectoryBucket', {
      dataRedundancy: 'SingleAvailabilityZone',
      locationName: `${this.region}c--x-s3`, // us-east-1c (use1-az4, S3 Express supported)
    });

    // go-to-k/cdkd#2762: the WHOLE-configuration removals. The guard bucket
    // declares an explicit SSE-S3 default encryption and a lifecycle rule
    // outside UPDATE mode only, so the UPDATE redeploy sends
    // DeleteBucketEncryption and DeleteBucketLifecycle. The updateMode read
    // is repeated here because the tagged bucket's block below defines it.
    if (process.env.CDKD_TEST_UPDATE !== 'true') {
      bucket.addPropertyOverride('BucketEncryption', {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      });
      bucket.addPropertyOverride('LifecycleConfiguration', {
        Rules: [{ Id: 'guard-expire', Status: 'Enabled', Prefix: 'old/', ExpirationInDays: 30 }],
      });
    }

    // Sibling bucket WITH template Tags (a handled property since issue
    // #609), including the `aws-cdk:auto-delete-objects` opt-in — its
    // data-carrying auto-empty must succeed in the same destroy that the
    // guard refuses on the untagged sibling. Tags are injected via
    // addPropertyOverride so the fixture does not depend on the aws-cdk-lib
    // codegen version that added the L1 `tags` prop.
    //
    // UPDATE mode (CDKD_TEST_UPDATE=true) mutates the tag set to exercise
    // the S3 Control TagResource / UntagResource update path live:
    // `cdkd-integ` changes value, `transient` is removed.
    const updateMode = process.env.CDKD_TEST_UPDATE === 'true';
    const autoBucket = new s3express.CfnDirectoryBucket(this, 'AutoDeleteBucket', {
      dataRedundancy: 'SingleAvailabilityZone',
      locationName: `${this.region}c--x-s3`,
    });
    autoBucket.addPropertyOverride('Tags', [
      { Key: 'aws-cdk:auto-delete-objects', Value: 'true' },
      { Key: 'cdkd-integ', Value: updateMode ? 'updated' : 'initial' },
      ...(updateMode ? [] : [{ Key: 'transient', Value: 'drop-me' }]),
    ]);

    // go-to-k/cdkd#2762: SSE-KMS default encryption on CREATE. SSE-S3 is what
    // a directory bucket reads as without any, so only a KMS key observes that
    // the create sent PutBucketEncryption. A directory bucket keeps ONE
    // customer managed key for its lifetime, so this is never changed. On the
    // TAGGED bucket, which Phase 3 deletes before the key: the untagged one
    // outlives that destroy, and its object must stay readable.
    const configKey = new kms.Key(this, 'ConfigKey', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
    });
    autoBucket.addPropertyOverride('BucketEncryption', {
      ServerSideEncryptionConfiguration: [
        {
          ServerSideEncryptionByDefault: {
            SSEAlgorithm: 'aws:kms',
            KMSMasterKeyID: configKey.keyArn,
          },
          BucketKeyEnabled: true,
        },
      ],
    });

    // go-to-k/cdkd#2762: lifecycle, metrics and inventory configurations on
    // the tagged bucket. UPDATE mode changes one lifecycle rule and drops the
    // other, swaps one metrics configuration for another, and removes the
    // inventory configuration entirely, so the Put, the per-Id Delete and the
    // whole-configuration Delete each run live.
    const inventoryDest = new s3.Bucket(this, 'InventoryDestination', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    autoBucket.addPropertyOverride('LifecycleConfiguration', {
      Rules: [
        {
          Id: 'expire-logs',
          Status: 'Enabled',
          Prefix: 'logs/',
          ObjectSizeGreaterThan: '1024',
          ExpirationInDays: updateMode ? 14 : 7,
        },
        ...(updateMode
          ? []
          : [
              {
                Id: 'abort-mpu',
                Status: 'Enabled',
                AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 },
              },
            ]),
      ],
    });
    autoBucket.addPropertyOverride('MetricsConfigurations', [
      { Id: 'all-objects' },
      updateMode ? { Id: 'tmp-prefix', Prefix: 'tmp/' } : { Id: 'logs-prefix', Prefix: 'logs/' },
    ]);
    if (!updateMode) {
      autoBucket.addPropertyOverride('InventoryConfigurations', [
        {
          Id: 'daily-inventory',
          Enabled: true,
          IncludedObjectVersions: 'Current',
          ScheduleFrequency: 'Daily',
          OptionalFields: ['Size', 'LastModifiedDate'],
          Destination: {
            BucketArn: inventoryDest.bucketArn,
            Format: 'CSV',
            Prefix: 'inventory/',
          },
        },
      ]);
    }

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.ref,
      description: 'Directory Bucket name (no opt-in — guard target)',
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: bucket.attrArn,
      description: 'Directory Bucket ARN',
    });

    new cdk.CfnOutput(this, 'AutoBucketName', {
      value: autoBucket.ref,
      description: 'Tagged directory bucket name (auto-delete opt-in)',
    });

    new cdk.CfnOutput(this, 'AutoBucketArn', {
      value: autoBucket.attrArn,
      description: 'Tagged directory bucket ARN',
    });

    new cdk.CfnOutput(this, 'ConfigKeyArn', {
      value: configKey.keyArn,
      description: "KMS key of the tagged bucket's default encryption",
    });

    new cdk.CfnOutput(this, 'InventoryDestinationArn', {
      value: inventoryDest.bucketArn,
      description: "General purpose bucket the tagged bucket's inventory reports go to",
    });
  }
}
