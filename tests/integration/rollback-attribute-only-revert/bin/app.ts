#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RollbackAttributeOnlyRevertStack } from '../lib/rollback-attribute-only-revert-stack.ts';

const app = new cdk.App();
new RollbackAttributeOnlyRevertStack(app, 'CdkdRollbackAttributeOnlyRevertExample', {
  description: 'cdkd automatic rollback of a DeletionPolicy-only update (go-to-k/cdkd#6101)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
