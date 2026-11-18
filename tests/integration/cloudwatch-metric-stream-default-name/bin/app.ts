#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CloudWatchMetricStreamDefaultNameStack } from '../lib/cloudwatch-metric-stream-default-name-stack.ts';

const app = new cdk.App();
new CloudWatchMetricStreamDefaultNameStack(app, 'CdkdCwMetricStreamDefaultName', {
  description: 'cdkd CloudWatch metric stream without an explicit name (issue #6555)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
