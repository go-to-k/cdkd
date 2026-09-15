#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OutputNeverResolvedDiffStack } from '../lib/output-never-resolved-diff-stack.ts';

const app = new cdk.App();

new OutputNeverResolvedDiffStack(app, 'CdkdOutputNeverResolvedDiffExample', {
  description:
    'cdkd fixture: an Output whose secret lookup fails on every deploy must not be a phantom ADD in cdkd diff --fail (issue #2740)',
  // `CDKD_TEST_ENV_AGNOSTIC=true` drops `env`, the shape `cdk init` produces:
  // CDK then gates its metadata resource on a `CDKMetadataAvailable` condition,
  // the one declared condition phase 5c's env-agnostic arm must not refuse the
  // merge preview over (go-to-k/cdkd#3101).
  ...(process.env.CDKD_TEST_ENV_AGNOSTIC === 'true'
    ? {}
    : {
        env: {
          account: process.env.CDK_DEFAULT_ACCOUNT,
          region: process.env.CDK_DEFAULT_REGION,
        },
      }),
});
