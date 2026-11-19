#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DriftVerbatimReadbackStack } from '../lib/drift-verbatim-readback-stack.ts';

const app = new cdk.App();
new DriftVerbatimReadbackStack(app, 'CdkdDriftVerbatimReadbackExample', {
  description: 'cdkd template-only drift readback probe for resource policies and IAM principals',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
