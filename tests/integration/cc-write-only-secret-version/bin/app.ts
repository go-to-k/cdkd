#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcWriteOnlySecretVersionStack } from '../lib/cc-write-only-secret-version-stack.ts';

const app = new cdk.App();

new CcWriteOnlySecretVersionStack(app, 'CdkdCcWriteOnlySecretVersionExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description:
    'A Cloud Control update leaves an unchanged secret-referenced password unsent only at its recorded version (go-to-k/cdkd#6824)',
});
