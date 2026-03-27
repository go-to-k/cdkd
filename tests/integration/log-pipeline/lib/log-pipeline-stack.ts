import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as destinations from 'aws-cdk-lib/aws-logs-destinations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';

/**
 * Log processing pipeline stack
 *
 * Demonstrates:
 * - CloudWatch LogGroup with retention
 * - Lambda Function (inline Python) as log processor
 * - SubscriptionFilter (LogGroup -> Lambda)
 * - Kinesis Data Stream as alternative destination
 * - MetricFilter on the LogGroup
 * - CloudWatch Alarm on the metric
 * - Kinesis Firehose DeliveryStream (S3 destination)
 * - CfnOutputs for log group name, function name, stream name, delivery stream name
 *
 * Tests AWS::Logs::SubscriptionFilter, AWS::Logs::MetricFilter, AWS::KinesisFirehose::DeliveryStream
 */
export class LogPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // CloudWatch LogGroup
    const logGroup = new logs.LogGroup(this, 'AppLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Lambda Function (inline Python log processor)
    const processor = new lambda.Function(this, 'LogProcessor', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import base64
import gzip
import json

def handler(event, context):
    payload = base64.b64decode(event['awslogs']['data'])
    log_data = json.loads(gzip.decompress(payload))
    print(f"Log group: {log_data['logGroup']}")
    print(f"Log stream: {log_data['logStream']}")
    for log_event in log_data['logEvents']:
        print(f"Log event: {log_event['message']}")
    return {'statusCode': 200, 'processedEvents': len(log_data['logEvents'])}
`),
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
    });

    // SubscriptionFilter: LogGroup -> Lambda
    new logs.SubscriptionFilter(this, 'LogSubscription', {
      logGroup,
      destination: new destinations.LambdaDestination(processor),
      filterPattern: logs.FilterPattern.allEvents(),
    });

    // Kinesis Data Stream as alternative destination
    const stream = new kinesis.Stream(this, 'LogStream', {
      streamName: `cdkd-log-pipeline-${this.stackName}`,
      shardCount: 1,
      retentionPeriod: cdk.Duration.hours(24),
    });

    // MetricFilter on the LogGroup
    const metricFilter = new logs.MetricFilter(this, 'ErrorMetric', {
      logGroup,
      metricNamespace: 'cdkd-test',
      metricName: 'ErrorCount',
      filterPattern: logs.FilterPattern.literal('ERROR'),
      metricValue: '1',
    });

    // CloudWatch Alarm on the metric
    const alarm = new cloudwatch.Alarm(this, 'ErrorAlarm', {
      alarmDescription: 'Alarm when error count exceeds threshold',
      metric: metricFilter.metric({
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // S3 Bucket for Firehose delivery
    const deliveryBucket = new s3.Bucket(this, 'DeliveryBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // IAM Role for Firehose to write to S3
    const firehoseRole = new iam.Role(this, 'FirehoseDeliveryRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
    });

    deliveryBucket.grantReadWrite(firehoseRole);

    // Kinesis Firehose DeliveryStream -> S3
    const deliveryStream = new firehose.CfnDeliveryStream(this, 'LogDeliveryStream', {
      deliveryStreamName: `cdkd-log-delivery-${this.account}`,
      s3DestinationConfiguration: {
        bucketArn: deliveryBucket.bucketArn,
        roleArn: firehoseRole.roleArn,
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'LogGroupName', {
      value: logGroup.logGroupName,
      description: 'CloudWatch Log Group name',
    });

    new cdk.CfnOutput(this, 'ProcessorFunctionName', {
      value: processor.functionName,
      description: 'Log processor Lambda function name',
    });

    new cdk.CfnOutput(this, 'StreamName', {
      value: stream.streamName,
      description: 'Kinesis Data Stream name',
    });

    new cdk.CfnOutput(this, 'AlarmArn', {
      value: alarm.alarmArn,
      description: 'CloudWatch Alarm ARN',
    });

    new cdk.CfnOutput(this, 'DeliveryStreamName', {
      value: deliveryStream.ref,
      description: 'Kinesis Firehose Delivery Stream name',
    });
  }
}
