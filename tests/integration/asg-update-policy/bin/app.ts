#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AsgUpdatePolicyStack } from '../lib/asg-update-policy-stack.ts';

const app = new cdk.App();
new AsgUpdatePolicyStack(app, 'CdkdAsgUpdatePolicyExample', {
  description: 'cdkd --update-policy Auto Scaling rolling / replacing update integ probe (issue #6437)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
