#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RdsSecurityBackfillStack } from '../lib/rds-security-backfill-stack.ts';

const app = new cdk.App();
new RdsSecurityBackfillStack(app, 'RdsSecurityBackfillStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
