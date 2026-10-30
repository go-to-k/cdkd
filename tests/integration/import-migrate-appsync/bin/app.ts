#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ImportMigrateAppSyncStack } from '../lib/import-migrate-appsync-stack.ts';

const app = new cdk.App();
new ImportMigrateAppSyncStack(app, 'CdkdImportMigrateAppSync', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
