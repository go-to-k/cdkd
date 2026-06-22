#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CognitoCustomAttributeAddStack } from '../lib/cognito-custom-attribute-add-stack.ts';

const app = new cdk.App();
new CognitoCustomAttributeAddStack(app, 'CdkdCognitoCustomAttributeAddExample', {
  description: 'cdkd Cognito UserPool add-custom-attribute (Schema in-place update) integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
