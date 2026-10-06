#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SecretDerivedImmutableNamesStack } from '../lib/secret-derived-immutable-names-stack.ts';
import { SecretDerivedOrphanStack } from '../lib/secret-derived-orphan-stack.ts';

const app = new cdk.App();

new SecretDerivedImmutableNamesStack(app, 'CdkdSecretDerivedImmutableNames', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Verifies an in-place update of resources whose immutable names come from a secret',
});

// Deployed only by its own step, to fail: a journaled orphan named from the
// secret (go-to-k/cdkd#3869).
new SecretDerivedOrphanStack(app, 'CdkdSecretDerivedOrphan', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Verifies a destroy of a failed-CREATE orphan named from a secret',
});
