#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GuarddutyDetectorUpdateStack } from '../lib/guardduty-detector-update-stack.ts';

const app = new cdk.App();
new GuarddutyDetectorUpdateStack(app, 'CdkdGuarddutyDetectorUpdateExample', {
  description: 'cdkd GuardDuty detector Cloud Control update integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
