#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DlmLifecyclePolicyStack } from '../lib/dlm-lifecycle-policy-stack.ts';

const app = new cdk.App();
new DlmLifecyclePolicyStack(app, 'CdkdDlmLifecyclePolicyExample', {
  description: 'cdkd integ: AWS::DLM::LifecyclePolicy SDK provider',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
