#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SnsEventSourceStack } from '../lib/sns-event-source-stack.ts';

const app = new cdk.App();
new SnsEventSourceStack(app, 'CdkdSnsEventSourceExample', {
  description: 'cdkd SNS -> Lambda via SnsEventSource functional integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
