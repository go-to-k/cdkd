#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SecretsmanagerUpdateValueSourceStack } from '../lib/secretsmanager-update-value-source-stack.ts';

const app = new cdk.App();
new SecretsmanagerUpdateValueSourceStack(app, 'CdkdSecretsmanagerUpdateValueSourceExample', {
  description:
    'AWS::SecretsManager::Secret in-place UPDATE keeps the secret value unless its source changed (issue #2472)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
