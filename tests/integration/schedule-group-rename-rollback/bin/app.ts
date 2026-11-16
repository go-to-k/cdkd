#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ScheduleGroupRenameRollbackStack } from '../lib/schedule-group-rename-rollback-stack.ts';

const app = new cdk.App();
new ScheduleGroupRenameRollbackStack(app, 'CdkdScheduleGroupRenameRollbackExample', {
  description: 'cdkd ScheduleGroup rename rollback keeps its schedules integ probe (issue #6374)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
