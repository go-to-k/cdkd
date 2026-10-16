#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SecretDerivedImmutableNamesStack } from '../lib/secret-derived-immutable-names-stack.ts';
import { SecretDerivedOrphanStack } from '../lib/secret-derived-orphan-stack.ts';
import { SecretDerivedNestedOutputStack } from '../lib/secret-derived-nested-output-stack.ts';

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

// Deployed only by its own step (1b): a parent reading a nested child's output
// that holds a name the child's provider rewrote from a secret (go-to-k/cdkd#3869).
new SecretDerivedNestedOutputStack(app, 'CdkdSdinNestedOutput', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: "Verifies a parent's read of a nested output holding a secret-derived name",
});
