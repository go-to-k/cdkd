#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ReplaceResourceFlagStack } from '../lib/replace-resource-flag-stack.ts';

const app = new cdk.App();
new ReplaceResourceFlagStack(app, 'CdkdReplaceResourceFlagExample', {
  description: 'cdkd deploy --replace-resource plans an update as a replacement (issue #7079)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
