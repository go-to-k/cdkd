#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ExportNestedStackExample } from '../lib/parent-stack.ts';

const app = new cdk.App();
new ExportNestedStackExample(app, 'CdkdExportNestedStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
