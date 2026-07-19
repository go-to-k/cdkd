#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { FsxOpenZfsStack } from '../lib/fsx-openzfs-stack.ts';

const app = new cdk.App();
new FsxOpenZfsStack(app, 'CdkdFsxOpenZfsExample', {
  description: 'cdkd integ: AWS::FSx::FileSystem SDK provider (OpenZFS SINGLE_AZ_1)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
