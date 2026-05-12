#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { StepFunctionsStack } from '../lib/stepfunctions-stack.ts';

const app = new cdk.App();
new StepFunctionsStack(app, 'StepFunctionsStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
