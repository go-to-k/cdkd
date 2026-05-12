#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DataAnalyticsStack } from '../lib/data-analytics-stack.ts';

const app = new cdk.App();
new DataAnalyticsStack(app, 'DataAnalyticsStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
