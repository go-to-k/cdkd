#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NestedStackSecretStack } from '../lib/nested-stack-secret-stack.ts';

const app = new cdk.App();
new NestedStackSecretStack(app, 'CdkdNestedStackSecretVerify', {
  description:
    'cdkd integ - a nested stack whose input Parameters carry secret dynamic references, and whose output feeds a parent resource',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
