#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaCapacityProviderDefaultNameStack } from '../lib/lambda-capacity-provider-default-name-stack.ts';

const app = new cdk.App();
new LambdaCapacityProviderDefaultNameStack(app, 'CdkdLmiCapacityProviderExample', {
  description: 'cdkd Lambda Managed Instances capacity provider without an explicit name (#3174)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
