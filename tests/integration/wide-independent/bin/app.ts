#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { WideIndependentStack } from '../lib/wide-independent-stack.ts';

const app = new cdk.App();
new WideIndependentStack(app, 'CdkdWideIndependentExample', {
  description: 'cdkd wide stack: 48 independent resources (issue #5209)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
