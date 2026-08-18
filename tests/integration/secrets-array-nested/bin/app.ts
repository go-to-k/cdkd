#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SecretsArrayNestedStack } from '../lib/secrets-array-nested-stack.ts';

const app = new cdk.App();
new SecretsArrayNestedStack(app, 'CdkdSecretsArrayNestedExample', {
  description: 'cdkd integ probe for a secret nested in an ARRAY (#1915)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
