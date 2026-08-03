import * as cdk from 'aws-cdk-lib';
import { DeletionPolicySnapshotHeavyStack } from '../lib/deletion-policy-snapshot-heavy-stack.ts';

const app = new cdk.App();

new DeletionPolicySnapshotHeavyStack(app, 'CdkdDeletionPolicySnapshotHeavyExample', {
  env: { region: process.env.AWS_REGION ?? 'us-east-1' },
});
