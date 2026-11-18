#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AthenaWorkgroupUpdateStack } from '../lib/athena-workgroup-update-stack.ts';

const app = new cdk.App();
new AthenaWorkgroupUpdateStack(app, 'CdkdAthenaWorkgroupUpdateExample', {
  description: 'cdkd Athena WorkGroup configuration in-place UPDATE integ probe (issue 6561)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
