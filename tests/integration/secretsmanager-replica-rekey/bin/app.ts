#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SecretsmanagerReplicaRekeyStack } from '../lib/secretsmanager-replica-rekey-stack.ts';

const app = new cdk.App();
new SecretsmanagerReplicaRekeyStack(app, 'CdkdSecretsmanagerReplicaRekeyExample', {
  description:
    'AWS::SecretsManager::Secret replica re-keyed in place when ReplicaRegions[].KmsKeyId changes (issues #5302, #5323)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
