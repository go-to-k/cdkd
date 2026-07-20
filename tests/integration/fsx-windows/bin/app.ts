#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { FsxWindowsStack } from '../lib/fsx-windows-stack.ts';

const app = new cdk.App();
new FsxWindowsStack(app, 'CdkdFsxWindowsExample', {
  description: 'cdkd integ: AWS::FSx::FileSystem SDK provider (Windows SINGLE_AZ_1, AD-joined)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
