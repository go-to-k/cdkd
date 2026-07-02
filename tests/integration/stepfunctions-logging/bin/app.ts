#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { StepfunctionsLoggingStack } from '../lib/stepfunctions-logging-stack.ts';

const app = new cdk.App();
new StepfunctionsLoggingStack(app, 'CdkdStepfunctionsLoggingExample', {
  description: 'cdkd Step Functions Express + LoggingConfiguration integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
