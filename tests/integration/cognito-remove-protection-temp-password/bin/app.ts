#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CognitoRemoveProtectionTempPasswordStack } from '../lib/cognito-remove-protection-temp-password-stack.ts';

const app = new cdk.App();
new CognitoRemoveProtectionTempPasswordStack(app, 'CdkdCognitoRemoveProtectionTempPasswordExample', {
  description: 'cdkd --remove-protection on a Cognito user pool with a temporary-password validity (issue #6548)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
