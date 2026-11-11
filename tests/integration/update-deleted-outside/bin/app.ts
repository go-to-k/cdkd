#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { UpdateDeletedOutsideStack } from '../lib/update-deleted-outside-stack.ts';

const app = new cdk.App();
new UpdateDeletedOutsideStack(app, 'CdkdUpdateDeletedOutsideExample', {
  description: 'cdkd failed UPDATE of a resource deleted outside cdkd integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
