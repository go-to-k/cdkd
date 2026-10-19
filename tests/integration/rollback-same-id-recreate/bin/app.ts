#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RollbackSameIdRecreateStack } from '../lib/rollback-same-id-recreate-stack.ts';

const app = new cdk.App();

new RollbackSameIdRecreateStack(app, 'CdkdRollbackSameIdRecreateExample', {
  description:
    'cdkd rollback integ: reversing a replacement that re-created a resource under the same physical id (#5096); env-gated via TABLE_KEY / LOG_CLASS / INJECT_FAIL',
});
