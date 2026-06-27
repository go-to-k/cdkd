#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EventbridgeSchedulerStack } from '../lib/eventbridge-scheduler-stack.ts';

const app = new cdk.App();
new EventbridgeSchedulerStack(app, 'CdkdEventbridgeSchedulerExample', {
  description: 'cdkd EventBridge Scheduler (CC-API) integ probe',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
