#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RecreateParentChildPermissionStack } from '../lib/recreate-parent-child-permission-stack.ts';

const app = new cdk.App();
new RecreateParentChildPermissionStack(app, 'CdkdRecreateParentChildPermissionExample', {
  description: 'cdkd same-id recreate of a Lambda function keeps its permission (issue #4411)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
