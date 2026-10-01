#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RemoveProtectionCompensationStack } from '../lib/remove-protection-compensation-stack.ts';

const app = new cdk.App();
new RemoveProtectionCompensationStack(app, 'CdkdRemoveProtectionCompensationExample', {
  description: 'cdkd --remove-protection compensation integ probe (issue #2204)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
