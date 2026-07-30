#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SnsPendingSubscriptionStack } from '../lib/sns-pending-subscription-stack.ts';

const app = new cdk.App();
new SnsPendingSubscriptionStack(app, 'CdkdSnsPendingSubscriptionExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
