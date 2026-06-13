#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RdsFullStackStack } from '../lib/rds-full-stack-stack.ts';

const app = new cdk.App();
new RdsFullStackStack(app, 'CdkdRdsFullStackExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
