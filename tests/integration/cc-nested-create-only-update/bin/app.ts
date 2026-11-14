#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcNestedCreateOnlyUpdateStack } from '../lib/cc-nested-create-only-update-stack.ts';

const app = new cdk.App();
new CcNestedCreateOnlyUpdateStack(app, 'CdkdCcNestedCreateOnlyUpdate', {
  description: 'cdkd Cloud Control update inside an object holding a nested create-only path',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
