#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaDestinationsStack } from '../lib/lambda-destinations-stack.ts';

const app = new cdk.App();
new LambdaDestinationsStack(app, 'CdkdLambdaDestinationsExample', {
  description: 'cdkd Lambda async destinations (EventInvokeConfig via Cloud Control) integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
