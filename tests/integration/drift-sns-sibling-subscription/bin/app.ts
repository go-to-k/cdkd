#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DriftSnsSiblingSubscriptionStack } from '../lib/drift-sns-sibling-subscription-stack.ts';

const app = new cdk.App();
new DriftSnsSiblingSubscriptionStack(app, 'CdkdDriftSnsSiblingSubscriptionExample', {
  description: 'cdkd SNS sibling subscription drift integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
