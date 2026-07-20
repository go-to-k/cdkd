#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ImportAutoModeStack } from '../lib/import-auto-mode-stack.ts';

const app = new cdk.App();
new ImportAutoModeStack(app, 'CdkdImportAutoModeExample', {
  description: 'cdkd import auto-mode integ probe (issue #1128)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
