#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SqsCloudwatchStack } from '../lib/sqs-cloudwatch-stack.ts';

const app = new cdk.App();

new SqsCloudwatchStack(app, 'CdkdSqsCloudwatchExample', {
  description:
    'cdkd integ: SQS+KMS+CloudWatch Alarm+SNS+Logs SubscriptionFilter to Kinesis stream',
});
