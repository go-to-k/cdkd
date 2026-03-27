#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ScheduledTaskStack } from '../lib/scheduled-task-stack';

const app = new cdk.App();
new ScheduledTaskStack(app, 'ScheduledTaskStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
