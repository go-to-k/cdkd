#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NestedCleanupAtRootStack } from '../lib/nested-cleanup-at-root-stack.ts';

const app = new cdk.App();
new NestedCleanupAtRootStack(app, 'CdkdNestedCleanupAtRootExample', {
  description: 'cdkd nested child cleanup waits for the root deploy integ probe (issue #6398)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
