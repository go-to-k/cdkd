#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaEventInvokeConfigUpdateStack } from '../lib/lambda-event-invoke-config-update-stack.ts';

const app = new cdk.App();
new LambdaEventInvokeConfigUpdateStack(app, 'CdkdLambdaEventInvokeConfigUpdateExample', {
  description: 'cdkd Lambda EventInvokeConfig async-invoke UPDATE integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
