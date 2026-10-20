#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcRequiredNameGenerationStack } from '../lib/cc-required-name-generation-stack.ts';

const app = new cdk.App();
new CcRequiredNameGenerationStack(app, 'CdkdCcRequiredNameGenerationExample', {
  description: 'cdkd integ: Cloud Control route generated name (issue 5095)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
