#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RdsDbInstanceBackfillStack } from '../lib/rds-dbinstance-backfill-stack.ts';

const app = new cdk.App();
new RdsDbInstanceBackfillStack(app, 'RdsDbInstanceBackfillStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
