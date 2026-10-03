#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IamRecreateReattachStack } from '../lib/iam-recreate-reattach-stack.ts';

const app = new cdk.App();
new IamRecreateReattachStack(app, 'CdkdIamRecreateReattachExample', {
  description: 'cdkd re-attaches what a same-name IAM role or group re-create detached (issue #4461)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
