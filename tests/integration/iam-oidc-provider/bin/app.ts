#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IamOidcProviderStack } from '../lib/iam-oidc-provider-stack.ts';

const app = new cdk.App();
new IamOidcProviderStack(app, 'CdkdIamOidcProviderExample', {
  description: 'cdkd GitHub Actions IAM OIDC provider (CDK custom resource) integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
