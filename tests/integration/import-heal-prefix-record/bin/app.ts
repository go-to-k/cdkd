#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ImportHealPrefixRecordStack } from '../lib/import-heal-prefix-record-stack.ts';

const app = new cdk.App();
new ImportHealPrefixRecordStack(app, 'CdkdImportHealPrefixRecord', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
