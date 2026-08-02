import * as cdk from 'aws-cdk-lib';
import { DeletionPolicySnapshotStack } from '../lib/deletion-policy-snapshot-stack.ts';

const app = new cdk.App();

new DeletionPolicySnapshotStack(app, 'CdkdDeletionPolicySnapshotExample', {
  env: { region: process.env.AWS_REGION ?? 'us-east-1' },
});
