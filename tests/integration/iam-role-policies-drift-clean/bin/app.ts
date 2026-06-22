#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IamRolePoliciesDriftCleanStack } from '../lib/iam-role-policies-drift-clean-stack.ts';

const app = new cdk.App();
new IamRolePoliciesDriftCleanStack(app, 'CdkdIamRolePoliciesDriftCleanExample', {
  description: 'cdkd IAM Role sibling-policy phantom-drift integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
