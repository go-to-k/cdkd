#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BackupStack } from '../lib/backup-stack.ts';

const app = new cdk.App();
new BackupStack(app, 'CdkdBackupExample', {
  description: 'cdkd AWS::Backup::* Fn::GetAtt (BackupVaultArn) enrichment integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
