#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RollbackObservedBaselineStack } from '../lib/rollback-observed-baseline-stack.ts';

const app = new cdk.App();

new RollbackObservedBaselineStack(app, 'CdkdRollbackObservedBaseline', {
  description:
    'A failed update rolled back in place refreshes the restored drift baseline (go-to-k/cdkd#6526)',
});
