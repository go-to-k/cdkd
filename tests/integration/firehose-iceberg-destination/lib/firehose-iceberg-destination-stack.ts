import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';

/** Deterministic names, so verify.sh's cleanup can find what a failed run left. */
export const STREAM_NAME = 'CdkdFirehoseIceberg5636';
export const DATABASE_NAME = 'cdkd_firehose_iceberg_5636';
/** IAM is global: the region suffix keeps runs in two regions apart. */
export const ROLE_NAME_PREFIX = 'CdkdFirehoseIceberg5636Role';

/**
 * Firehose `IcebergDestinationConfiguration` on the SDK route (issue #5636).
 *
 * covers: AWS::KinesisFirehose::DeliveryStream
 * covers: AWS::Glue::Database
 *
 * Before the fix the property was not in the provider's `handledProperties`,
 * so the stream routed through Cloud Control (recorded `provisionedBy:
 * "cc-api"`). The SDK route now sends it, in the SDK spelling of the three
 * members CloudFormation names differently: `s3BackupMode` (`S3BackupMode`),
 * `CatalogConfiguration.CatalogArn` (`CatalogARN`), and on the read side the
 * nested `S3DestinationDescription` (`S3Configuration`).
 *
 * Mode list (`CDKD_TEST_UPDATE`): '' (phase 1) | 'true' (phase 2: buffering
 * interval 60 -> 120, retry 300 -> 600, destination table events ->
 * events_v2; every one an in-place `UpdateDestination`). The backup mode stays
 * `FailedDataOnly`, the only value Firehose accepts for Iceberg today (the
 * SDK's member docs), so no phase can change it.
 *
 * No record is ever put, so Firehose creates no table and writes nothing to
 * the bucket: only control-plane resources exist.
 */
export class FirehoseIcebergDestinationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = (process.env.CDKD_TEST_UPDATE ?? '').includes('true');

    const bucket = new s3.CfnBucket(this, 'Bucket');
    bucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const database = new glue.CfnDatabase(this, 'Database', {
      catalogId: this.account,
      databaseInput: { name: DATABASE_NAME },
    });

    const role = new iam.CfnRole(this, 'Role', {
      roleName: `${ROLE_NAME_PREFIX}-${this.region}`,
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'firehose.amazonaws.com' },
            Action: 'sts:AssumeRole',
            // The confused-deputy guard Firehose's own role docs use.
            Condition: { StringEquals: { 'sts:ExternalId': this.account } },
          },
        ],
      },
      policies: [
        {
          policyName: 'iceberg',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: [
                  's3:AbortMultipartUpload',
                  's3:GetBucketLocation',
                  's3:GetObject',
                  's3:ListBucket',
                  's3:ListBucketMultipartUploads',
                  's3:PutObject',
                  's3:DeleteObject',
                ],
                Resource: [bucket.attrArn, `${bucket.attrArn}/*`],
              },
              {
                Effect: 'Allow',
                Action: ['glue:GetDatabase', 'glue:GetTable', 'glue:CreateTable', 'glue:UpdateTable'],
                Resource: [
                  `arn:${this.partition}:glue:${this.region}:${this.account}:catalog`,
                  `arn:${this.partition}:glue:${this.region}:${this.account}:database/${DATABASE_NAME}`,
                  `arn:${this.partition}:glue:${this.region}:${this.account}:table/${DATABASE_NAME}/*`,
                ],
              },
            ],
          },
        },
      ],
    });

    const stream = new firehose.CfnDeliveryStream(this, 'Stream', {
      deliveryStreamName: STREAM_NAME,
      deliveryStreamType: 'DirectPut',
      icebergDestinationConfiguration: {
        roleArn: role.attrArn,
        catalogConfiguration: {
          catalogArn: `arn:${this.partition}:glue:${this.region}:${this.account}:catalog`,
          warehouseLocation: `s3://${bucket.ref}/warehouse/`,
        },
        destinationTableConfigurationList: [
          {
            destinationDatabaseName: DATABASE_NAME,
            destinationTableName: isUpdate ? 'events_v2' : 'events',
          },
        ],
        schemaEvolutionConfiguration: { enabled: true },
        tableCreationConfiguration: { enabled: true },
        bufferingHints: { intervalInSeconds: isUpdate ? 120 : 60, sizeInMBs: 1 },
        retryOptions: { durationInSeconds: isUpdate ? 600 : 300 },
        s3BackupMode: 'FailedDataOnly',
        s3Configuration: {
          bucketArn: bucket.attrArn,
          roleArn: role.attrArn,
          errorOutputPrefix: 'errors/',
        },
      },
    });
    stream.addResourceDependency(database);

    new cdk.CfnOutput(this, 'StreamName', { value: stream.ref });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.ref });
    new cdk.CfnOutput(this, 'RoleArn', { value: role.attrArn });
  }
}
