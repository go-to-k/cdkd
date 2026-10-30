#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MarkerStack } from '../lib/local-invoke-stage-stack.ts';

const app = new cdk.App();

// A top-level stack beside the Stage, so the app is multi-stack and a target
// cannot fall back to single-stack auto-detection.
new MarkerStack(app, 'CdkdLocalInvokeStageTop', { marker: 'top' });

// The subject (issue go-to-k/cdkd#3953): stacks inside a NESTED Stage display
// as `CdkdLocalInvokeStage/Inner/Api`, so a target's first `/`-segment is the
// outer Stage id, never a stack. `ApiV2` is a sibling whose display path the
// `Api` one is a string prefix of, so the `/` boundary is exercised too.
const outer = new cdk.Stage(app, 'CdkdLocalInvokeStage');
const inner = new cdk.Stage(outer, 'Inner');
new MarkerStack(inner, 'Api', { marker: 'api' });
new MarkerStack(inner, 'ApiV2', { marker: 'api-v2' });

// Issue go-to-k/cdkd#5175: one Stage deployed twice (Beta / Prod), its stack
// carrying ONE explicit physical stackName in both. A target naming that
// shared name must be refused as ambiguous, never resolved to the first Stage.
for (const [stage, marker] of [
  ['CdkdLocalInvokeStageBeta', 'beta'],
  ['CdkdLocalInvokeStageProd', 'prod'],
] as const) {
  new MarkerStack(new cdk.Stage(app, stage), 'Api', {
    marker,
    stackName: 'CdkdLocalInvokeStageShared',
  });
}

// Issue go-to-k/cdkd#5181: two top-level stacks with UNIQUE physical names that
// reuse the construct ids `Handler` and `Api`, so their logical ids are equal.
// `start-api --stack 'CdkdLocalInvokeStageSvc*'` must serve each stack's route
// from its own handler, Stage and CORS -- #5177 refused the union instead.
new MarkerStack(app, 'CdkdLocalInvokeStageSvcA', { marker: 'svc-a', httpApi: true });
new MarkerStack(app, 'CdkdLocalInvokeStageSvcB', { marker: 'svc-b', httpApi: true });
