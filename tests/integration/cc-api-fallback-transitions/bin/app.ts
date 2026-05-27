#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OverrideStack, UpdateTransitionStack } from '../lib/transitions-stack.ts';

const app = new cdk.App();

new OverrideStack(app, 'CdkdCcApiOverride', {
  description:
    'cdkd #634 item 3 — --allow-unsupported-properties override path integ probe',
});

new UpdateTransitionStack(app, 'CdkdCcApiTransition', {
  description:
    'cdkd #634 item 4 — SDK→CC mid-life re-route integ probe (toggled via CDKD_INTEG_USE_LOGGING_CONFIG env var)',
});
