#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { StepfunctionsSyncManagedRuleStack } from '../lib/stepfunctions-sync-managed-rule-stack.ts';

const app = new cdk.App();
new StepfunctionsSyncManagedRuleStack(app, 'CdkdStepfunctionsSyncManagedRuleExample', {
  description: 'cdkd Step Functions .sync integration first-deploy (managed rule absent) integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
