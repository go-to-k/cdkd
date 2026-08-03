import * as cdk from 'aws-cdk-lib';
import { RollbackDeletionPolicySnapshotStack } from '../lib/rollback-deletion-policy-snapshot-stack.ts';

const app = new cdk.App();

new RollbackDeletionPolicySnapshotStack(app, 'CdkdRollbackSnapshotExample', {
  env: { region: process.env.AWS_REGION ?? 'us-east-1' },
});
