#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SchedulerCustomGroupStack } from '../lib/scheduler-custom-group-stack.ts';

const app = new cdk.App();
new SchedulerCustomGroupStack(app, 'CdkdSchedulerCustomGroupExample', {
  description: 'cdkd Scheduler custom-group SDK provider integ (issue 961)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
