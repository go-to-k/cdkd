#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RefactorCommandStack } from '../lib/refactor-command-stack.ts';

const app = new cdk.App();
new RefactorCommandStack(app, 'CdkdRefactorCommandExample', {
  description: 'cdkd refactor: renamed construct ids keep their AWS resources',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
