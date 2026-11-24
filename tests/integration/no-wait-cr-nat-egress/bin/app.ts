#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NoWaitCrNatEgressStack } from '../lib/no-wait-cr-nat-egress-stack.ts';

const app = new cdk.App();
new NoWaitCrNatEgressStack(app, 'CdkdNoWaitCrNatEgressExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
