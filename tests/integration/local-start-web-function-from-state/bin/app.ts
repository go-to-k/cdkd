#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartWebFunctionFromStateStack } from '../lib/local-start-web-function-from-state-stack.ts';

const app = new cdk.App();

new LocalStartWebFunctionFromStateStack(app, 'CdkdLocalStartWebFunctionFromState', {
  description: 'Fixture stack for cdkd local start-web-function --from-state integ test',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
