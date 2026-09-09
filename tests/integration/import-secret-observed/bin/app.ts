#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ImportSecretObservedStack } from '../lib/import-secret-observed-stack.ts';

const app = new cdk.App();
new ImportSecretObservedStack(app, 'CdkdImportSecretObservedExample', {
  description:
    'cdkd import: the observedProperties baseline of a secret-bearing property must persist as the expression',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
