#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SnsSubscriptionFilterStack } from '../lib/sns-subscription-filter-stack.ts';

const app = new cdk.App();
new SnsSubscriptionFilterStack(app, 'CdkdSnsSubscriptionFilterExample', {
  description: 'cdkd SNS -> SQS subscription with a filterPolicy integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
