#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { StepFunctionsS3Stack } from '../lib/stepfunctions-s3-stack.ts';

const app = new cdk.App();
new StepFunctionsS3Stack(app, 'StepFunctionsS3Stack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
