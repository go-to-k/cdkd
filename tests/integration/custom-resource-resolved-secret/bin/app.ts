#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CustomResourceResolvedSecretStack } from '../lib/custom-resource-resolved-secret-stack.ts';

const app = new cdk.App();
new CustomResourceResolvedSecretStack(app, 'CdkdCrResolvedSecretExample', {
  description: 'cdkd never sends a resolved secret to a custom-resource handler (issue #4009)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
