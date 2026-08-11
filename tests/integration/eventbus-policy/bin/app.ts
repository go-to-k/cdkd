#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EventbusPolicyStack } from '../lib/eventbus-policy-stack.ts';

const app = new cdk.App();
new EventbusPolicyStack(app, 'CdkdEventbusPolicyExample', {
  description: 'cdkd EventBridge EventBusPolicy integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
