#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ReplacedDeleteFailedRollbackStack } from '../lib/replaced-delete-failed-rollback-stack.ts';

const app = new cdk.App();
new ReplacedDeleteFailedRollbackStack(app, 'CdkdReplacedDeleteFailedRollback', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
