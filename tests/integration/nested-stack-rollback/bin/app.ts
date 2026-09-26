#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NestedStackRollbackStack } from '../lib/nested-stack-rollback-stack.ts';

const app = new cdk.App();

new NestedStackRollbackStack(app, 'CdkdNestedRollback3754', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description:
    'cdkd nested-stack rollback integ (issue #3754): does the automatic rollback revert a nested child the failed deploy already updated? env-gated via CHILD_VT / INJECT_FAIL',
});
