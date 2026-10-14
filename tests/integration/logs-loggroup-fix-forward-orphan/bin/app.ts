#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LogsLogGroupFixForwardOrphanStack } from '../lib/logs-loggroup-fix-forward-orphan-stack.ts';

const app = new cdk.App();
new LogsLogGroupFixForwardOrphanStack(app, 'CdkdLogsLogGroupFixForwardOrphan', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
