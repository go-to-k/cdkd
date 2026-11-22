#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BudgetsActionStack } from '../lib/budgets-action-stack.ts';

const app = new cdk.App();

new BudgetsActionStack(app, 'CdkdBudgetsActionExample', {
  description: 'AWS::Budgets::BudgetsAction created right after its same-stack execution role',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
