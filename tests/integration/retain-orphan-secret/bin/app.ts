#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RetainOrphanSecretStack } from '../lib/retain-orphan-secret-stack.ts';

const app = new cdk.App();
new RetainOrphanSecretStack(app, 'CdkdRetainOrphanSecretExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
