#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { UpdatePolicyMutationsStack } from '../lib/update-policy-mutations-stack.ts';

const app = new cdk.App();

const region = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

new UpdatePolicyMutationsStack(app, 'CdkdUpdatePolicyMutationsExample', {
  description:
    'Update-time handling of DeletionPolicy / UpdateReplacePolicy / DependsOn changes + metadata-only no-ops + orphan-on-replace. Phase selected via `-c phase=a|b`.',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
});
