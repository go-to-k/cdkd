#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RecreateTargetReadersStack } from '../lib/recreate-target-readers-stack.ts';

const app = new cdk.App();
new RecreateTargetReadersStack(app, 'CdkdRecreateTargetReadersExample', {
  description: 'cdkd --recreate-via-cc-api same-stack reader integ probe (issue #4383)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
