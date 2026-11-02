#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NeptuneRestoreStack } from '../lib/neptune-restore-stack.ts';

const app = new cdk.App();
new NeptuneRestoreStack(app, 'CdkdNeptuneRestore', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
