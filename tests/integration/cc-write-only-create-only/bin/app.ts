#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcWriteOnlyCreateOnlyStack } from '../lib/cc-write-only-create-only-stack.ts';

const app = new cdk.App();
new CcWriteOnlyCreateOnlyStack(app, 'CdkdCcWriteOnlyCreateOnly', {
  description: 'cdkd Cloud Control update of write-only keys holding create-only paths (#4416)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
