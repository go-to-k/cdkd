#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CrossRegionConcurrentStack } from '../lib/cross-region-concurrent-stack.ts';

const app = new cdk.App();

// Both regions come from `verify.sh`; the defaults keep a bare `cdk synth`
// working for a manual inspection.
const regionA = process.env['CDKD_IT_XRC_REGION_A'] ?? 'us-east-1';
const regionB = process.env['CDKD_IT_XRC_REGION_B'] ?? 'us-west-2';
const sourceParameterName = process.env['CDKD_IT_XRC_SOURCE_PARAM'] ?? '/cdkd-xrc/source';

// The DECLARATION order decides which stack cdkd starts first (`matchStacks`
// walks the assembly's order and ignores argv order), and the stack started
// LAST is the one whose global switch used to win. `verify.sh` flips it between
// its two concurrent deploys so each stack is on the losing side once.
const stacks = [
  { id: 'CdkdCrossRegionConcurrentAExample', letter: 'a', region: regionA },
  { id: 'CdkdCrossRegionConcurrentBExample', letter: 'b', region: regionB },
];
if (process.env['CDKD_IT_XRC_ORDER'] === 'ba') stacks.reverse();

for (const { id, letter, region } of stacks) {
  new CrossRegionConcurrentStack(app, id, {
    description: `cdkd issue #1981: stack ${letter} of a concurrent cross-region deploy`,
    env: { region },
    letter,
    sourceParameterName,
  });
}
