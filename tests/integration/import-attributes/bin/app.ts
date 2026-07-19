#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ImportAttributesStack } from '../lib/import-attributes-stack.ts';

const app = new cdk.App();
new ImportAttributesStack(app, 'CdkdImportAttributesExample', {
  description: 'cdkd import attribute-persistence integ probe (issue #1098)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
