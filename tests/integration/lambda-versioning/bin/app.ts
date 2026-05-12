#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaVersioningStack } from '../lib/lambda-versioning-stack.ts';

const app = new cdk.App();
new LambdaVersioningStack(app, 'LambdaVersioningStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
