#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StepFunctionsStack } from '../lib/stepfunctions-stack';

const app = new cdk.App();
new StepFunctionsStack(app, 'StepFunctionsStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
