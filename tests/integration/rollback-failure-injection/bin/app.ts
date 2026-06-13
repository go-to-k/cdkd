#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RollbackFailureStack } from '../lib/rollback-failure-stack.ts';

const app = new cdk.App();

new RollbackFailureStack(app, 'CdkdRollbackFailureExample', {
  description:
    'Rich multi-resource stack exercising the cdkd deploy-engine ROLLBACK path (env-gated failure injection via ROLLBACK_INTEG_FAIL)',
});
