#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EsmReplacementRollbackStack } from '../lib/esm-replacement-rollback-stack.ts';

const app = new cdk.App();

new EsmReplacementRollbackStack(app, 'CdkdEsmReplacementRollback', {
  description:
    'Rolls back a Lambda EventSourceMapping replacement seconds after the new mapping was created (go-to-k/cdkd#7011)',
});
