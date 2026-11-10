#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RdsDbInstanceBackupReplicationStack } from '../lib/rds-dbinstance-backup-replication-stack.ts';

const app = new cdk.App();
new RdsDbInstanceBackupReplicationStack(app, 'CdkdRdsDbInstanceBackupReplicationExample', {
  description: 'cdkd RDS DBInstance automated backup replication integ probe (go-to-k/cdkd#5640)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
