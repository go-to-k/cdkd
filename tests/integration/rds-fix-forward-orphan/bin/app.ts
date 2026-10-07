#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RdsFixForwardOrphanStack } from '../lib/rds-fix-forward-orphan-stack.ts';

const app = new cdk.App();
new RdsFixForwardOrphanStack(app, 'CdkdRdsFixForwardOrphan', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
