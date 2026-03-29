#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DataAnalyticsStack } from '../lib/data-analytics-stack';

const app = new cdk.App();
new DataAnalyticsStack(app, 'DataAnalyticsStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
