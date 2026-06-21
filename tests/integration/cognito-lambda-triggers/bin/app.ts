#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CognitoLambdaTriggersStack } from '../lib/cognito-lambda-triggers-stack.ts';

const app = new cdk.App();
new CognitoLambdaTriggersStack(app, 'CdkdCognitoLambdaTriggersExample', {
  description: 'cdkd Cognito UserPool Lambda triggers (preSignUp/postConfirmation) integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
