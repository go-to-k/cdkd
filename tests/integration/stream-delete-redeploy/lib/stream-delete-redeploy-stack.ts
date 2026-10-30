import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * cdkd destroy-then-immediate-redeploy probe for NAMED streams (issue #3872).
 *
 * Kinesis and Firehose keep a stream's NAME while it is DELETING, and refuse a
 * create of that name with the same `already exists` text a live stream gets.
 * `delete()` used to return the moment the delete call was accepted, so a
 * redeploy landing inside the window (Firehose: ~100s) failed. verify.sh
 * destroys, checks the streams are already gone, and redeploys at once.
 *
 * covers: AWS::KinesisFirehose::DeliveryStream
 * covers: AWS::Kinesis::Stream
 * covers: AWS::Kinesis::StreamConsumer
 *
 * The named consumer rides the stream so a live `RegisterStreamConsumer` goes
 * through the provider's dedicated create client (issue #4639).
 *
 * The stream and role names are stable within a run (`CDKD_SRD_RUN_ID`) so the
 * redeploy re-creates the SAME names. The bucket name carries the phase
 * (`CDKD_SRD_PHASE`) instead: S3 can hold a just-deleted bucket name too, and
 * that would fail the redeploy for a reason this probe is not about.
 *
 * `CDKD_SRD_TAG` sets the delivery stream's one tag; verify.sh's Phase 3b
 * changes it, an in-place update through the Firehose provider's `update()`
 * and its recorded-region guard (issue #2613).
 *
 * The destination is ExtendedS3, whose create and update must apply
 * `FileExtension` and `CustomTimeZone` (issue #1160). `CDKD_SRD_FILE_EXT` sets
 * the extension; `CDKD_SRD_TRIM=1` removes `Prefix`, `ErrorOutputPrefix` and
 * `CustomTimeZone` from the template, which CloudFormation leaves live.
 *
 * `CDKD_SRD_ENC=1` adds `DeliveryStreamEncryptionConfigurationInput` with an
 * AWS-owned key; dropping it again is a removal, which CloudFormation answers
 * with `StopDeliveryStreamEncryption` (issue #5357).
 *
 * A second delivery stream uses the legacy `S3DestinationConfiguration`.
 * `CDKD_SRD_LEGACY_V2=1` changes its BufferingHints, Prefix and
 * CompressionFormat, which CloudFormation applies in place (issue #5439).
 */
export class StreamDeleteRedeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const runId = process.env.CDKD_SRD_RUN_ID ?? 'manual';
    const phase = process.env.CDKD_SRD_PHASE ?? 'a';
    const tagValue = process.env.CDKD_SRD_TAG ?? 'base';
    const fileExtension = process.env.CDKD_SRD_FILE_EXT ?? '.json';
    const trim = process.env.CDKD_SRD_TRIM === '1';
    const encrypt = process.env.CDKD_SRD_ENC === '1';

    const stream = new kinesis.Stream(this, 'Stream', {
      streamName: `cdkd-stream-redeploy-${runId}`,
      streamMode: kinesis.StreamMode.PROVISIONED,
      shardCount: 1,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new kinesis.CfnStreamConsumer(this, 'Consumer', {
      consumerName: `cdkd-stream-redeploy-${runId}`,
      streamArn: stream.streamArn,
    });

    const bucket = new s3.Bucket(this, 'DeliveryBucket', {
      bucketName: `cdkd-stream-redeploy-${this.account}-${runId}-${phase}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const role = new iam.Role(this, 'DeliveryRole', {
      roleName: `cdkd-stream-redeploy-${runId}`,
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
    });
    bucket.grantReadWrite(role);

    const deliveryStream = new firehose.CfnDeliveryStream(this, 'DeliveryStream', {
      deliveryStreamName: `cdkd-stream-redeploy-${runId}`,
      extendedS3DestinationConfiguration: {
        bucketArn: bucket.bucketArn,
        roleArn: role.roleArn,
        fileExtension,
        ...(trim
          ? {}
          : { prefix: 'data/', errorOutputPrefix: 'errors/', customTimeZone: 'Asia/Tokyo' }),
      },
      tags: [{ key: 'cdkd-srd', value: tagValue }],
      ...(encrypt && { deliveryStreamEncryptionConfigurationInput: { keyType: 'AWS_OWNED_CMK' } }),
    });
    // The role's grant policy must exist before Firehose validates the role.
    deliveryStream.node.addDependency(role);

    const legacyV2 = process.env.CDKD_SRD_LEGACY_V2 === '1';
    const legacyStream = new firehose.CfnDeliveryStream(this, 'LegacyS3DeliveryStream', {
      deliveryStreamName: `cdkd-stream-redeploy-legacy-${runId}`,
      s3DestinationConfiguration: {
        bucketArn: bucket.bucketArn,
        roleArn: role.roleArn,
        ...(legacyV2
          ? {
              prefix: 'legacy-b/',
              compressionFormat: 'GZIP',
              bufferingHints: { intervalInSeconds: 120, sizeInMBs: 10 },
            }
          : {
              prefix: 'legacy-a/',
              compressionFormat: 'UNCOMPRESSED',
              bufferingHints: { intervalInSeconds: 60, sizeInMBs: 5 },
            }),
      },
    });
    legacyStream.node.addDependency(role);
  }
}
