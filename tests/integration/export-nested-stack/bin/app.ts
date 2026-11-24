#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ExportNestedStackExample } from '../lib/parent-stack.ts';

const app = new cdk.App();
new ExportNestedStackExample(app, 'CdkdExportNestedStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  // go-to-k/cdkd#6887: a stack tag, which the export must put on BOTH
  // CloudFormation stacks (the child's through its flip).
  tags: { 'cdkd-integ-stack-tag': 'export-nested-6887' },
});
