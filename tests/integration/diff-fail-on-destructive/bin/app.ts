#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DiffFailOnDestructiveStack } from '../lib/diff-fail-on-destructive-stack.ts';

const app = new cdk.App();
new DiffFailOnDestructiveStack(app, 'CdkdDiffFailOnDestructiveExample', {
  description: 'cdkd diff --fail-on=destructive / deploy --require-approval=destructive integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
