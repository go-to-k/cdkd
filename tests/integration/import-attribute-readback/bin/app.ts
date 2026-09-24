#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ImportAttributeReadbackStack } from '../lib/import-attribute-readback-stack.ts';

const app = new cdk.App();
new ImportAttributeReadbackStack(app, 'CdkdImportAttributeReadback', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
