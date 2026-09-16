#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Elbv2SameNameReplacementStack } from '../lib/elbv2-same-name-replacement-stack.ts';

const app = new cdk.App();

// The stack id IS the stack name, and the stack name is the prefix cdkd's
// `generateResourceName` puts in front of the logical id when it mints a
// `FALLBACK_NAME_RULES` name. Here that cap is TIGHT rather than roomy:
// `AWS::ElasticLoadBalancingV2::TargetGroup` carries `maxLength: 32`, so
// `CdkdElbv2SameName` (17 chars) yields `CdkdElbv2SameName-Tg` — 20 characters,
// comfortably under the cap, which keeps the minted name PLAIN. A longer stack
// id would push past 32 and send `generateResourceName` into its
// truncate-plus-hash branch, and verify.sh's `<stack>-` prefix assertion would
// then be comparing against a hashed name.
new Elbv2SameNameReplacementStack(app, 'CdkdElbv2SameName', {
  description:
    'Same-name replacement of a cdkd-named ELBv2 target group (issue #3208): changing the ' +
    'create-only Port must complete under `cdkd deploy --replace`, whose delete-first ' +
    'fallback only engages when ELBv2 DuplicateTargetGroupNameException is recognised as a ' +
    'name collision',
});
