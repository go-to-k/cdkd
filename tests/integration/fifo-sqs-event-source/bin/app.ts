#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { FifoSqsEventSourceStack } from '../lib/fifo-sqs-event-source-stack.ts';

const app = new cdk.App();
new FifoSqsEventSourceStack(app, 'CdkdFifoSqsEventSourceExample', {
  description: 'cdkd FIFO SQS queue as a Lambda event source integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
