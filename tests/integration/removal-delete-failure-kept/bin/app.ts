#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RemovalDeleteFailureKeptStack } from '../lib/removal-delete-failure-kept-stack.ts';

const app = new cdk.App();
new RemovalDeleteFailureKeptStack(app, 'CdkdRemovalDeleteKeptExample', {
  description: 'cdkd removed resource whose delete fails keeps the deploy integ (issue #6969)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
