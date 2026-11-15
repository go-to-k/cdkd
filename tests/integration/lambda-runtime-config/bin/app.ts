#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaRuntimeConfigStack } from '../lib/lambda-runtime-config-stack.ts';

const runtimeArn = process.env['CDKD_IT_RUNTIME_ARN'];
if (!runtimeArn) {
  throw new Error('CDKD_IT_RUNTIME_ARN is required: verify.sh creates the runtime and sets it');
}

const app = new cdk.App();
new LambdaRuntimeConfigStack(app, 'CdkdLambdaRuntimeConfigExample', {
  description: 'cdkd Lambda Function RuntimeConfig (issue #6352) integ',
  runtimeArn,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
