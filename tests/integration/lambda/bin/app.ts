#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaStack } from '../lib/lambda-stack.ts';

const app = new cdk.App();
new LambdaStack(app, 'LambdaStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
