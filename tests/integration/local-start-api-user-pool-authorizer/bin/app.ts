#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartApiUserPoolAuthorizerStack } from '../lib/local-start-api-user-pool-authorizer-stack.ts';

const app = new cdk.App();

new LocalStartApiUserPoolAuthorizerStack(app, 'CdkdLocalStartApiUserPoolAuthorizer', {
  description: 'Fixture stack for cdkd local start-api --from-state with HttpUserPoolAuthorizer',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
