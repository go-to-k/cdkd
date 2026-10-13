#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaFixForwardOrphanStack } from '../lib/lambda-fix-forward-orphan-stack.ts';

const app = new cdk.App();
new LambdaFixForwardOrphanStack(app, 'CdkdLambdaFixForwardOrphan', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
