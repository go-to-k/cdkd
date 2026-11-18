import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * A CloudWatch metric stream that declares NO `name` (issue #6555).
 *
 * `AWS::CloudWatch::MetricStream` has no SDK provider, so it goes through
 * Cloud Control, whose create handler fails with `Cannot invoke
 * "java.lang.CharSequence.length()" because "this.text" is null` when the name
 * is omitted (CloudFormation names it `<stack>-<logicalId>-<random>`). cdkd now
 * generates one. CDK has no L2, so the stream is the L1 `CfnMetricStream`, as
 * an app writes it: a Firehose delivery stream to S3 and a role the metric
 * streams service assumes.
 *
 * `CDKD_TEST_UPDATE=true` changes `OutputFormat` (json -> opentelemetry1.0)
 * and adds an include filter: both mutable, so the Cloud Control UPDATE path
 * must keep the stream (and its generated name) in place.
 *
 * covers: AWS::CloudWatch::MetricStream
 * covers: AWS::KinesisFirehose::DeliveryStream
 */
export class CloudWatchMetricStreamDefaultNameStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const updating = process.env.CDKD_TEST_UPDATE === 'true';

    // The stream delivers metrics while it runs, so the bucket is not empty at
    // destroy: the auto-delete custom resource empties it.
    const bucket = new s3.Bucket(this, 'MetricBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    // The S3 destination creates a RETAINed log group of its own unless given
    // one: this one is destroyed with the stack.
    const deliveryLogs = new logs.LogGroup(this, 'DeliveryLogs', {
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const delivery = new firehose.DeliveryStream(this, 'Delivery', {
      destination: new firehose.S3Bucket(bucket, {
        loggingConfig: new firehose.EnableLogging(deliveryLogs),
      }),
    });

    const role = new iam.Role(this, 'MetricStreamRole', {
      assumedBy: new iam.ServicePrincipal('streams.metrics.cloudwatch.amazonaws.com'),
    });
    delivery.grantPutRecords(role);

    // Deliberately no `name`: the case under test.
    const stream = new cloudwatch.CfnMetricStream(this, 'MetricStream', {
      firehoseArn: delivery.deliveryStreamArn,
      roleArn: role.roleArn,
      outputFormat: updating ? 'opentelemetry1.0' : 'json',
      includeFilters: updating
        ? [{ namespace: 'AWS/Lambda' }, { namespace: 'AWS/S3' }]
        : [{ namespace: 'AWS/Lambda' }],
    });
    // The role's policy must exist before the stream starts delivering.
    stream.node.addDependency(role);

    new cdk.CfnOutput(this, 'MetricStreamName', { value: stream.ref });
    new cdk.CfnOutput(this, 'MetricStreamArn', { value: stream.attrArn });
    new cdk.CfnOutput(this, 'DeliveryStreamName', { value: delivery.deliveryStreamName });
  }
}
