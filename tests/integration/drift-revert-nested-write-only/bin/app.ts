#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DriftRevertNestedWriteOnlyStack } from '../lib/drift-revert-nested-write-only-stack.ts';

const app = new cdk.App();
new DriftRevertNestedWriteOnlyStack(app, 'CdkdDriftRevertNestedWriteOnlyExample', {
  description: 'cdkd drift --revert on nested write-only properties integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
