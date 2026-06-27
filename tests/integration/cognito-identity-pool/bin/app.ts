#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CognitoIdentityPoolStack } from '../lib/cognito-identity-pool-stack.ts';

const app = new cdk.App();
new CognitoIdentityPoolStack(app, 'CdkdCognitoIdentityPoolExample', {
  description: 'cdkd Cognito Identity Pool (CC-API) integ probe',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
