#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ImportAttributeReadbackFinalStack } from '../lib/import-attribute-readback-final-stack.ts';

const app = new cdk.App();
new ImportAttributeReadbackFinalStack(app, 'CdkdImportAttrReadbackFinal', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
