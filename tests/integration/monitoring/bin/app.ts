#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MonitoringStack } from '../lib/monitoring-stack.ts';

const app = new cdk.App();
new MonitoringStack(app, 'MonitoringStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
