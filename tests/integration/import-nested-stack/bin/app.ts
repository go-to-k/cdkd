#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ImportNestedStackExample } from '../lib/parent-stack.ts';

const app = new cdk.App();
new ImportNestedStackExample(app, 'CdkdImportNestedStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  // go-to-k/cdkd#6887: a stack tag CloudFormation propagates to both stacks'
  // resources, which the migration must record on each imported resource.
  tags: { 'cdkd-integ-stack-tag': 'import-nested-6887' },
});
