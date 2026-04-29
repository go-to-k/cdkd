#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SqsCloudwatchStack } from '../lib/sqs-cloudwatch-stack';

const app = new cdk.App();

new SqsCloudwatchStack(app, 'CdkdSqsCloudwatchExample', {
  description:
    'cdkd integ: SQS+KMS+CloudWatch Alarm+SNS+Logs SubscriptionFilter to Kinesis stream',
});
