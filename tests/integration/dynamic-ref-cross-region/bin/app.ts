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
const secureSourceParameterName =
  process.env['CDKD_IT_DYNREF_SECURE_PARAM'] ?? '/cdkd-test/dynref-cross-region-secure';
// The MIXED-TYPE name: a plain `String` in region A and a `SecureString` in
// region B (issue #1957 acceptance criterion 3). Seeded by `verify.sh`.
const mixedTypeSourceParameterName =
  process.env['CDKD_IT_DYNREF_MIXED_PARAM'] ?? '/cdkd-test/dynref-cross-region-mixed';

// The region-B ARN of the shared String parameter, for the #2134
// assembled-foreign arm. Region A's stack ONLY: the arm exists to prove a
// reference is answered by the region its ARN names rather than by the stack's
// own, so putting it on both stacks would make "foreign" ambiguous.
const foreignParameterArn = process.env['CDKD_IT_DYNREF_FOREIGN_ARN'];

new DynamicRefCrossRegionStack(app, 'CdkdDynamicRefCrossRegionAStack', {
  description: 'Resolves a shared {{resolve:ssm:...}} expression in region A (cdkd issue #1933)',
  env: { region: regionA },
  sourceParameterName,
  secureSourceParameterName,
  mixedTypeSourceParameterName,
  ...(foreignParameterArn ? { foreignParameterArn } : {}),
});

new DynamicRefCrossRegionStack(app, 'CdkdDynamicRefCrossRegionBStack', {
  description: 'Resolves the SAME expression in region B (cdkd issue #1933)',
  env: { region: regionB },
  sourceParameterName,
  secureSourceParameterName,
  mixedTypeSourceParameterName,
});
