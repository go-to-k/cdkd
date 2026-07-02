#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaArchSwitchStack } from '../lib/lambda-arch-switch-stack.ts';

const app = new cdk.App();
new LambdaArchSwitchStack(app, 'CdkdLambdaArchSwitchExample', {
  description: 'cdkd Lambda architecture switch (x86_64 <-> arm64) integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
