#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MultiRegionStack } from '../lib/multi-region-stack';

const app = new cdk.App();

// Region is selected via CDKD_INTEG_REGION at deploy time so the same stack
// name can be re-targeted to a different region on the second deploy run —
// which is what we're trying to exercise. CDK falls back to env-agnostic
// stacks when no region is set, but PR 1's region check requires a concrete
// region in state, so we always resolve one here.
const region =
  process.env.CDKD_INTEG_REGION ??
  process.env.CDK_DEFAULT_REGION ??
  process.env.AWS_REGION ??
  'us-east-1';

new MultiRegionStack(app, 'CdkdMultiRegionExample', {
  description:
    'Single-resource fixture stack used by tests/integration/multi-region-same-stack to ' +
    'verify that the same stackName deployed to two regions yields two independent state files.',
  env: { region },
});
