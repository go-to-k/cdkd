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
