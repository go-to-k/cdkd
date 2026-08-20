#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SnsSubscriptionUpdateStack } from '../lib/sns-subscription-update-stack.ts';

const app = new cdk.App();
new SnsSubscriptionUpdateStack(app, 'CdkdSnsSubscriptionUpdateExample', {
  description: 'cdkd standalone AWS::SNS::Subscription UPDATE replacement integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
