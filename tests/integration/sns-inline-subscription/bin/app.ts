#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SnsInlineSubscriptionStack } from '../lib/sns-inline-subscription-stack.ts';

const app = new cdk.App();
new SnsInlineSubscriptionStack(app, 'CdkdSnsInlineSubscriptionExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
