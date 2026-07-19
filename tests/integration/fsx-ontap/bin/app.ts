#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { FsxOntapStack } from '../lib/fsx-ontap-stack.ts';

const app = new cdk.App();
new FsxOntapStack(app, 'CdkdFsxOntapExample', {
  description: 'cdkd integ: AWS::FSx::FileSystem SDK provider (ONTAP SINGLE_AZ_1)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
