#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SecretDerivedImmutableNamesStack } from '../lib/secret-derived-immutable-names-stack.ts';

const app = new cdk.App();

new SecretDerivedImmutableNamesStack(app, 'CdkdSecretDerivedImmutableNames', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Verifies an in-place update of resources whose immutable names come from a secret',
});
