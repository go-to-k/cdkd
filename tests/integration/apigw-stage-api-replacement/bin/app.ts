#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApigwStageApiReplacementStack } from '../lib/apigw-stage-api-replacement-stack.ts';

const app = new cdk.App();
new ApigwStageApiReplacementStack(app, 'CdkdApigwStageApiReplacementExample', {
  description: 'cdkd integ: an API Gateway stage moved to a replaced API is replaced (issue 7072)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
