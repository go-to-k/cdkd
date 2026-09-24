#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ImportRetainDestroyStack } from '../lib/import-retain-destroy-stack.ts';

const app = new cdk.App();
new ImportRetainDestroyStack(app, 'CdkdImportRetainDestroy', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
