#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IamSiblingManagedPolicyDriftStack } from '../lib/iam-sibling-managed-policy-drift-stack.ts';

const app = new cdk.App();
new IamSiblingManagedPolicyDriftStack(app, 'CdkdIamSiblingManagedPolicyDriftExample', {
  description: 'cdkd IAM principal sibling ManagedPolicy drift integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
