#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DocdbFixForwardOrphanStack } from '../lib/docdb-fix-forward-orphan-stack.ts';

const app = new cdk.App();
new DocdbFixForwardOrphanStack(app, 'CdkdDocdbFixForwardOrphan', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
