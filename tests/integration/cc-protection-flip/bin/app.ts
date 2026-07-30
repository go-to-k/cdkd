#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcProtectionFlipStack } from '../lib/cc-protection-flip-stack.ts';

const app = new cdk.App();
new CcProtectionFlipStack(app, 'CdkdCcProtectionFlipExample', {
  description: 'cdkd generic CC protection flip integ (destroy --remove-protection, issue #1314)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
