#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GlobalTableFixForwardOrphanStack } from '../lib/globaltable-fix-forward-orphan-stack.ts';

const app = new cdk.App();
new GlobalTableFixForwardOrphanStack(app, 'CdkdGlobalTableFixForwardOrphan', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
