#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RequireApprovalBroadeningStack } from '../lib/require-approval-broadening-stack.ts';

const app = new cdk.App();
new RequireApprovalBroadeningStack(app, 'CdkdRequireApprovalBroadeningExample', {
  description: 'cdkd diff --fail-on=broadening / deploy --require-approval=broadening integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
