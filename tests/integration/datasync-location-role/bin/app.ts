#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DatasyncLocationRoleStack } from '../lib/datasync-location-role-stack.ts';

const app = new cdk.App();
new DatasyncLocationRoleStack(app, 'CdkdDatasyncLocationRole', {
  description: 'cdkd DataSync S3 locations created with a same-stack role (issue #6573)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
