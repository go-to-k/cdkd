#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DriftRevertReadbackPlaceholdersStack } from '../lib/drift-revert-readback-placeholders-stack.ts';

const app = new cdk.App();
new DriftRevertReadbackPlaceholdersStack(app, 'CdkdDriftRevertPlaceholdersExample', {
  description: 'cdkd drift --revert past read-back placeholders (AppSync, Glue) integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
