#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ImportNestedStackExample } from '../lib/parent-stack.ts';

const app = new cdk.App();
new ImportNestedStackExample(app, 'CdkdImportNestedStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
