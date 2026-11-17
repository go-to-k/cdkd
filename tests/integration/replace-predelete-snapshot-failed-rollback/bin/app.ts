#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ReplacePredeleteSnapshotFailedRollbackStack } from '../lib/replace-predelete-snapshot-failed-rollback-stack.ts';

const app = new cdk.App();
new ReplacePredeleteSnapshotFailedRollbackStack(app, 'CdkdReplacePredeleteSnapshotFailedRollback', {
  description: 'cdkd UpdateReplacePolicy: Snapshot EBS volume replacement rollback integ',
  env: {
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  },
});
