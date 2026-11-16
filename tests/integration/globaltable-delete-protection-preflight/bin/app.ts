#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GlobalTableDeleteProtectionPreflightStack } from '../lib/globaltable-delete-protection-preflight-stack.ts';

const app = new cdk.App();
new GlobalTableDeleteProtectionPreflightStack(app, 'CdkdGlobalTableDeleteProtectionPreflight', {
  description: 'cdkd GlobalTable delete refuses before stripping replicas (issue #6367)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
