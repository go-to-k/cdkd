#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaLogRetentionStack } from '../lib/lambda-log-retention-stack.ts';

const app = new cdk.App();
new LambdaLogRetentionStack(app, 'CdkdLambdaLogRetentionExample', {
  description: 'cdkd Lambda logRetention (Custom::LogRetention) deploy + in-place UPDATE integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
