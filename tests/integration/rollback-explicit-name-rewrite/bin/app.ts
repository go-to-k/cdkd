#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RollbackExplicitNameRewriteStack } from '../lib/rollback-explicit-name-rewrite-stack.ts';

const app = new cdk.App();

new RollbackExplicitNameRewriteStack(app, 'CdkdRollbackNameRewriteExample', {
  description:
    'cdkd rollback explicit-name integ — a reverse-replacement re-creates an explicitly named IAM Role under the name its deploy sent (#4018) and refuses a squatter on that name (#4010); env-gated via ROLE_SUFFIX / ROLE_DESCRIPTION_V2 / INJECT_FAIL',
});
