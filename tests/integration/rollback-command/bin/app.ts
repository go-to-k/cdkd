#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RollbackCommandStack, RollbackInitialStack } from '../lib/rollback-command-stack.ts';

const app = new cdk.App();

new RollbackCommandStack(app, 'CdkdRollbackCommandExample', {
  description:
    'Standalone cdkd rollback command integ — clean v1 deploy, failing v2 --no-rollback deploy (writes a rollback journal), then cdkd rollback to revert (env-gated via MARKER_VALUE / WITH_EXTRA / INJECT_FAIL)',
});

new RollbackInitialStack(app, 'CdkdRollbackCommandInitial', {
  description:
    'Standalone cdkd rollback command integ — first-ever failing --no-rollback deploy exercising the initialDeploy path (cdkd rollback deletes state.json)',
});
