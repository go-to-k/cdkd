#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IamProfilePolicyFixForwardOrphanStack } from '../lib/iam-profile-policy-fix-forward-orphan-stack.ts';

const app = new cdk.App();
new IamProfilePolicyFixForwardOrphanStack(app, 'CdkdIamProfilePolicyFixForwardOrphan', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
