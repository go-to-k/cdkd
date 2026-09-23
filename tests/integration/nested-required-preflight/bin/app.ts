#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NestedRequiredStack } from '../lib/nested-required-stack.ts';

const app = new cdk.App();
new NestedRequiredStack(app, 'CdkdNestedRequiredPreflight', {
  description: 'cdkd nested required pre-flight refusal integ (issue #1802)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
