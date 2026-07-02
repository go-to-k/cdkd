#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SyntheticsCanaryStack } from '../lib/synthetics-canary-stack.ts';

const app = new cdk.App();
new SyntheticsCanaryStack(app, 'CdkdSyntheticsCanaryExample', {
  description: 'cdkd Synthetics Canary (CC-API) integ probe',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
