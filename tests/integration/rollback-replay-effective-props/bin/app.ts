#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RollbackReplayStack } from '../lib/rollback-replay-stack.ts';

const app = new cdk.App();

new RollbackReplayStack(app, 'CdkdRollbackReplayEffProps', {
  description:
    'Reverse-replacement rollback whose replay-CREATE substitutes a malformed state bag (issue #1682; env-gated via ROUTE_DEST / ROLLBACK_INTEG_FAIL)',
});
