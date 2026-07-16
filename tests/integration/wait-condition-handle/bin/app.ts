#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { WaitConditionHandleStack } from '../lib/wait-condition-handle-stack.ts';

const app = new cdk.App();
new WaitConditionHandleStack(app, 'CdkdWaitConditionHandleExample', {
  description: 'cdkd WaitConditionHandle no-op provider integ (issue 1020)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
