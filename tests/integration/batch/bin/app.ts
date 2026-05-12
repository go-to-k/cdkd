#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BatchStack } from '../lib/batch-stack.ts';

const app = new cdk.App();
new BatchStack(app, 'BatchStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
