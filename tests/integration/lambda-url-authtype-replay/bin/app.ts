#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaUrlAuthTypeReplayStack } from '../lib/lambda-url-authtype-replay-stack.ts';

const app = new cdk.App();
new LambdaUrlAuthTypeReplayStack(app, 'CdkdLambdaUrlAuthTypeReplayExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
