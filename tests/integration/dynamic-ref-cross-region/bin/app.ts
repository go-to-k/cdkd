#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DynamicRefCrossRegionStack } from '../lib/dynamic-ref-cross-region-stack.ts';

const app = new cdk.App();

// Both regions and the shared source-parameter name come from `verify.sh`
// (the parameter name carries the account id, so it cannot be hardcoded).
// The defaults keep a bare `cdk synth` working for a manual inspection.
const regionA = process.env['CDKD_IT_DYNREF_REGION_A'] ?? 'us-east-1';
const regionB = process.env['CDKD_IT_DYNREF_REGION_B'] ?? 'us-west-2';
const sourceParameterName =
  process.env['CDKD_IT_DYNREF_SOURCE_PARAM'] ?? '/cdkd-test/dynref-cross-region';

new DynamicRefCrossRegionStack(app, 'CdkdDynamicRefCrossRegionAStack', {
  description: 'Resolves a shared {{resolve:ssm:...}} expression in region A (cdkd issue #1933)',
  env: { region: regionA },
  sourceParameterName,
});

new DynamicRefCrossRegionStack(app, 'CdkdDynamicRefCrossRegionBStack', {
  description: 'Resolves the SAME expression in region B (cdkd issue #1933)',
  env: { region: regionB },
  sourceParameterName,
});
