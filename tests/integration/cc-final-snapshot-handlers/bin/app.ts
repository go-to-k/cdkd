#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcFinalSnapshotHandlersStack } from '../lib/cc-final-snapshot-handlers-stack.ts';

const app = new cdk.App();
new CcFinalSnapshotHandlersStack(app, 'CdkdCcFinalSnapshotHandlersExample', {
  description: 'cdkd Cloud Control final-snapshot handler integ probe (issue #4029)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
