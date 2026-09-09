#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OutputNeverResolvedDiffStack } from '../lib/output-never-resolved-diff-stack.ts';

const app = new cdk.App();

new OutputNeverResolvedDiffStack(app, 'CdkdOutputNeverResolvedDiffExample', {
  description:
    'cdkd fixture: an Output whose secret lookup fails on every deploy must not be a phantom ADD in cdkd diff --fail (issue #2740)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
