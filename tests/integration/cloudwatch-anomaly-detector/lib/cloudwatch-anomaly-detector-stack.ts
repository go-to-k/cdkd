import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

/**
 * Fixture for issue #1304: the AWS::CloudWatch::AnomalyDetector SDK provider.
 *
 * CREATE: an anomaly detection model on the queue's NumberOfMessagesSent
 * metric (the L1 top-level single-metric tuple — what CfnAnomalyDetector
 * emits for the plain usage).
 *
 * UPDATE (CDKD_TEST_UPDATE=true): adds a Configuration (MetricTimeZone) —
 * the only in-place-mutable property per the registry schema (everything
 * else is createOnly and would classify as replacement).
 */
export class CloudWatchAnomalyDetectorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const queue = new sqs.Queue(this, 'MetricQueue', {
      queueName: 'cdkd-anomaly-detector-queue',
    });

    new cloudwatch.CfnAnomalyDetector(this, 'Detector', {
      namespace: 'AWS/SQS',
      metricName: 'NumberOfMessagesSent',
      stat: 'Sum',
      dimensions: [{ name: 'QueueName', value: queue.queueName }],
      ...(isUpdate
        ? {
            configuration: {
              // NOTE: the CFn property is MetricTimeZone (capital Z) while
              // the SDK field is MetricTimezone (lowercase z) — the provider
              // re-keys it; verify.sh asserts the value reads back.
              metricTimeZone: 'UTC',
              excludedTimeRanges: [
                {
                  startTime: '2026-01-01T00:00:00Z',
                  endTime: '2026-01-02T00:00:00Z',
                },
              ],
            },
          }
        : {}),
    });
  }
}
