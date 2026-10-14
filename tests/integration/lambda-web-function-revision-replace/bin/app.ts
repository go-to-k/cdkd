#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaWebFunctionRevisionReplaceStack } from '../lib/lambda-web-function-revision-replace-stack.ts';

const app = new cdk.App();
new LambdaWebFunctionRevisionReplaceStack(app, 'CdkdLambdaWebFunctionRevisionReplaceExample', {
  description: 'cdkd Lambda Web Function revision replacement integ (go-to-k/cdkd#4900)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
