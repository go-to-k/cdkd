#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { VpcLambdaStack } from '../lib/vpc-lambda-stack.ts';

const app = new cdk.App();
new VpcLambdaStack(app, 'VpcLambdaStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
