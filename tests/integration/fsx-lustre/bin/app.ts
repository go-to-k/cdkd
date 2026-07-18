#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { FsxLustreStack } from '../lib/fsx-lustre-stack.ts';

const app = new cdk.App();
new FsxLustreStack(app, 'CdkdFsxLustreExample', {
  description: 'cdkd integ: AWS::FSx::FileSystem SDK provider (Lustre SCRATCH_2)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
