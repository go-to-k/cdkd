#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SsmGeneratedNameGrantStack } from '../lib/ssm-generated-name-grant-stack.ts';

const app = new cdk.App();
new SsmGeneratedNameGrantStack(app, 'CdkdSsmGeneratedNameGrantExample', {
  description: 'cdkd auto-named SSM parameter read through grantRead integ probe (issue #6272)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
