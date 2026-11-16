#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ReplaceSnapshotFailedRollbackStack } from '../lib/replace-snapshot-failed-rollback-stack.ts';

const app = new cdk.App();
new ReplaceSnapshotFailedRollbackStack(app, 'CdkdReplaceSnapshotFailedRollback', {
  description: 'cdkd UpdateReplacePolicy: Snapshot replacement rollback integ',
  env: {
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  },
});
