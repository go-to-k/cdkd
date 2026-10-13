#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IamUserGroupFixForwardOrphanStack } from '../lib/iam-user-group-fix-forward-orphan-stack.ts';

const app = new cdk.App();
new IamUserGroupFixForwardOrphanStack(app, 'CdkdIamUserGroupFixForwardOrphan', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
