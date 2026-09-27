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
 *
 * The stream and role names are stable within a run (`CDKD_SRD_RUN_ID`) so the
 * redeploy re-creates the SAME names. The bucket name carries the phase
 * (`CDKD_SRD_PHASE`) instead: S3 can hold a just-deleted bucket name too, and
 * that would fail the redeploy for a reason this probe is not about.
 */
export class StreamDeleteRedeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const runId = process.env.CDKD_SRD_RUN_ID ?? 'manual';
    const phase = process.env.CDKD_SRD_PHASE ?? 'a';

    new kinesis.Stream(this, 'Stream', {
      streamName: `cdkd-stream-redeploy-${runId}`,
      streamMode: kinesis.StreamMode.PROVISIONED,
      shardCount: 1,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
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
      s3DestinationConfiguration: {
        bucketArn: bucket.bucketArn,
        roleArn: role.roleArn,
      },
    });
    // The role's grant policy must exist before Firehose validates the role.
    deliveryStream.node.addDependency(role);
  }
}
