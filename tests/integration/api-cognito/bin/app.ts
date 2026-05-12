#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApiCognitoStack } from '../lib/api-cognito-stack.ts';

const app = new cdk.App();
new ApiCognitoStack(app, 'ApiCognitoStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
