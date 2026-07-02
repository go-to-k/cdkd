#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApigwStageThrottlingStack } from '../lib/apigw-stage-throttling-stack.ts';

const app = new cdk.App();
new ApigwStageThrottlingStack(app, 'ApigwStageThrottlingStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
