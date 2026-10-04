#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ImportRetainDestroyStack, ImportRollbackStack } from '../lib/import-retain-destroy-stack.ts';

const app = new cdk.App();
new ImportRetainDestroyStack(app, 'CdkdImportRetainDestroy', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
// go-to-k/cdkd#4523: deployed by cdkd only, never by `cdk deploy`.
new ImportRollbackStack(app, 'CdkdImportRollback', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
