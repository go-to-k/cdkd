#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ImportMigratePendingChangeStack } from '../lib/import-migrate-pending-change-stack.ts';

const app = new cdk.App();
new ImportMigratePendingChangeStack(app, 'CdkdImportMigratePendingChangeExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
