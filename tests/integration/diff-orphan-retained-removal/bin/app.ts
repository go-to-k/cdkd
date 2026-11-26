#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DiffOrphanRetainedRemovalStack } from '../lib/diff-orphan-retained-removal-stack.ts';

const app = new cdk.App();
new DiffOrphanRetainedRemovalStack(app, 'CdkdDiffOrphanRetainedRemovalExample', {
  description: 'cdkd diff / deploy orphan display for a removed retained resource (issue #7005)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
