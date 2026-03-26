#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CloudWatchStack } from '../lib/cloudwatch-stack';

const app = new cdk.App();
new CloudWatchStack(app, 'CloudWatchStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
