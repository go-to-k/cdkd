#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RdsDbInstanceSnapshotRestoreStack } from '../lib/rds-dbinstance-snapshot-restore-stack.ts';

const app = new cdk.App();
new RdsDbInstanceSnapshotRestoreStack(app, 'CdkdRdsInstanceSnapshotRestoreExample', {
  description: 'cdkd RDS DB instance snapshot restore integ',
  env: {
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  },
});
