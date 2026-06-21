#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IamRolePrefixedNameUpdateStack } from '../lib/iam-role-prefixed-name-update-stack.ts';

const app = new cdk.App();
new IamRolePrefixedNameUpdateStack(app, 'CdkdIamRolePrefixedNameUpdateExample', {
  description: 'cdkd in-place UPDATE of an IAM role whose name starts with the stack name',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
