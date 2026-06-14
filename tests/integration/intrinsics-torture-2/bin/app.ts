#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IntrinsicsTorture2Stack } from '../lib/intrinsics-torture-2-stack.ts';

const app = new cdk.App();

new IntrinsicsTorture2Stack(app, 'CdkdIntrinsicsTorture2Example', {
  description:
    'cdkd torture test #2 — harder intrinsic-function arg shapes feeding real SSM parameter values',
});
