#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DynamoDBGlobalTableReplicaSettingsStack } from '../lib/dynamodb-globaltable-replica-settings-stack.ts';

const app = new cdk.App();
const region = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1';
// verify.sh sets CDKD_INTEG_RUN_ID, giving each run its own stack name.
const runId = process.env.CDKD_INTEG_RUN_ID;
const stackName = `CdkdDynamoDBGlobalTableReplicaSettingsExample${runId ? `-${runId}` : ''}`;
new DynamoDBGlobalTableReplicaSettingsStack(app, stackName, {
  description:
    'cdkd GlobalTable replica KMS key, table class and deletion protection (issue #5355)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  // verify.sh passes both; the defaults keep a bare synth working (the key
  // ARN is then a placeholder no deploy should use).
  secondRegion:
    process.env.CDKD_INTEG_SECOND_REGION ?? (region === 'us-west-2' ? 'us-east-1' : 'us-west-2'),
  replicaKeyArn:
    process.env.CDKD_INTEG_REPLICA_KEY_ARN ??
    'arn:aws:kms:us-west-2:111111111111:key/00000000-0000-0000-0000-000000000000',
  replicaKey2Arn:
    process.env.CDKD_INTEG_REPLICA_KEY2_ARN ??
    'arn:aws:kms:us-west-2:111111111111:key/00000000-0000-0000-0000-000000000001',
});
