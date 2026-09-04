#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SsmSecureDynamicRefStack } from '../lib/ssm-secure-dynamic-ref-stack.ts';

const app = new cdk.App();

new SsmSecureDynamicRefStack(app, 'CdkdSsmSecureDynamicRefExample', {
  description:
    'cdkd fixture for the {{resolve:ssm-secure:...}} dynamic reference (issue #2482): resolved to the SecureString value, redacted in state',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
