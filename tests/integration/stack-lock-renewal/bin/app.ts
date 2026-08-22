#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { StackLockRenewalStack } from '../lib/stack-lock-renewal-stack.ts';

const app = new cdk.App();
new StackLockRenewalStack(app, 'CdkdStackLockRenewalExample', {
  description: 'cdkd stack-lock renewal integ (issue #2168): a deploy that outlives one renewal interval',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
