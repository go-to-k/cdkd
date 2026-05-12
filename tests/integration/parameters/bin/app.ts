#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ParametersStack } from '../lib/parameters-stack.ts';

const app = new cdk.App();
new ParametersStack(app, 'ParametersStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
