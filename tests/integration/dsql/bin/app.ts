#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DsqlStack } from '../lib/dsql-stack.ts';

const app = new cdk.App();
new DsqlStack(app, 'CdkdDsqlExample', {
  description: 'cdkd Aurora DSQL cluster integ (Cloud Control API fallback path)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
