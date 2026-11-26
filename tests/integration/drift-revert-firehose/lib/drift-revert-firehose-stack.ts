import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * Integ probe for go-to-k/cdkd#7019: `cdkd drift --revert` on an S3-destination
 * Firehose delivery stream failed whatever drifted (`Bucket ARN is required for
 * S3 destination`), because the read-back's empty placeholder blocks
 * (`S3BackupConfiguration: {}` and siblings) were sent back to
 * `UpdateDestination` as written.
 *
 * - `L2`: the CDK L2 `S3Bucket` destination (`ExtendedS3DestinationConfiguration`).
 * - `Legacy`: the L1 `S3DestinationConfiguration`, which AWS reads back in the
 *   ExtendedS3 shape too.
 * - `Processor`: a Lambda the verify script attaches to `L2` as a processor out
 *   of band, for the revert back to "no processing".
 */
export class DriftRevertFirehoseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'Bucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new firehose.DeliveryStream(this, 'L2', {
      destination: new firehose.S3Bucket(bucket, {
        dataOutputPrefix: 'l2/',
        bufferingInterval: cdk.Duration.seconds(300),
        bufferingSize: cdk.Size.mebibytes(5),
        loggingConfig: new firehose.DisableLogging(),
      }),
    });

    const legacyRole = new iam.Role(this, 'LegacyRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
    });
    bucket.grantReadWrite(legacyRole);
    const legacy = new firehose.CfnDeliveryStream(this, 'Legacy', {
      deliveryStreamType: 'DirectPut',
      s3DestinationConfiguration: {
        bucketArn: bucket.bucketArn,
        roleArn: legacyRole.roleArn,
        prefix: 'legacy/',
        bufferingHints: { intervalInSeconds: 300, sizeInMBs: 5 },
        compressionFormat: 'GZIP',
      },
    });
    legacy.node.addDependency(legacyRole);

    new lambda.Function(this, 'Processor', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async (e) => ({ records: [] });'),
      logGroup: new logs.LogGroup(this, 'ProcessorLogs', {
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        retention: logs.RetentionDays.ONE_DAY,
      }),
    });
  }
}
