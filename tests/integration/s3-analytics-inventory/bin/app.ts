#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { S3AnalyticsInventoryStack } from '../lib/s3-analytics-inventory-stack.ts';

const app = new cdk.App();
new S3AnalyticsInventoryStack(app, 'CdkdS3AnalyticsInventoryExample', {
  description: 'cdkd S3 analytics + inventory destination integ probe (issue #1493)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
