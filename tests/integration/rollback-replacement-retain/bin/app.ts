#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RollbackReplacementRetainStack } from '../lib/rollback-replacement-retain-stack.ts';

const app = new cdk.App();

new RollbackReplacementRetainStack(app, 'CdkdRollbackReplacementRetainExample', {
  description:
    'Replacement rollback under UpdateReplacePolicy: Retain keeps the NEW physical copy (issue #2598; env-gated via RETAIN_PARAM_NAME / CONTROL_PARAM_NAME / DELETION_POLICY_PARAM_NAME / ROLLBACK_RETAIN_INTEG_FAIL)',
});
