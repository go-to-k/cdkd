#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AppSyncStack } from '../lib/appsync-stack';

const app = new cdk.App();
new AppSyncStack(app, 'AppSyncStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
