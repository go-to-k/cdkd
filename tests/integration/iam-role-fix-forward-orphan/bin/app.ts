#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IamRoleFixForwardOrphanStack } from '../lib/iam-role-fix-forward-orphan-stack.ts';

const app = new cdk.App();
new IamRoleFixForwardOrphanStack(app, 'CdkdIamRoleFixForwardOrphan', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
