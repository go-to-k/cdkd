#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SupersededStageEqualIdStack } from '../lib/superseded-stage-equal-id-stack.ts';

const app = new cdk.App();
new SupersededStageEqualIdStack(app, 'CdkdSupersededStageEqualIdExample', {
  description: 'cdkd integ: an old stage on another API whose delete fails stays tracked (issue 7088)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
