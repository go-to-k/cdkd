#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LogsDeliveryStack } from '../lib/logs-delivery-stack.ts';

const app = new cdk.App();
new LogsDeliveryStack(app, 'CdkdLogsDeliveryExample', {
  description: 'cdkd CloudWatch Logs delivery SDK provider integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
