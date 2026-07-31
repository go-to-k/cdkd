#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IamAccessKeyStack } from '../lib/iam-access-key-stack.ts';

const app = new cdk.App();
new IamAccessKeyStack(app, 'CdkdIamAccessKeyExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
