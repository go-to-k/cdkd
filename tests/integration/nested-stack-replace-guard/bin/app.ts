#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NestedStackReplaceGuardStack } from '../lib/nested-stack-replace-guard-stack.ts';

const app = new cdk.App();
new NestedStackReplaceGuardStack(app, 'CdkdNestedStackReplaceGuardExample', {
  description: 'cdkd nested-stack replacement stateful-guard integ probe (issue #2548)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
