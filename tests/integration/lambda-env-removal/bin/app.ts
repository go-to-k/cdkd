#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaEnvRemovalStack } from '../lib/lambda-env-removal-stack.ts';

const app = new cdk.App();
new LambdaEnvRemovalStack(app, 'CdkdLambdaEnvRemovalExample', {
  description: 'cdkd nested-map-key removal (Lambda env var) integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
