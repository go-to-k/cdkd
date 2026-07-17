#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CodeCommitStack } from '../lib/codecommit-stack.ts';

const app = new cdk.App();
new CodeCommitStack(app, 'CdkdCodeCommitExample', {
  description: 'cdkd CodeCommit Repository SDK provider integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
