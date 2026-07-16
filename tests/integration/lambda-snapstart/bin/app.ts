#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaSnapstartStack } from '../lib/lambda-snapstart-stack.ts';

const app = new cdk.App();
new LambdaSnapstartStack(app, 'CdkdLambdaSnapstartExample', {
  description: 'cdkd Lambda SnapStart (published versions) + Version/Alias rotation integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
