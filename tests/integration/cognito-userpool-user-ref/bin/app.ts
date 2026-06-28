#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CognitoUserPoolUserRefStack } from '../lib/cognito-userpool-user-ref-stack.ts';

const app = new cdk.App();
new CognitoUserPoolUserRefStack(app, 'CdkdCognitoUserPoolUserRefExample', {
  description: 'cdkd Cognito UserPoolUser Ref (compound-id after-pipe) integ probe',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
