#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BudgetsStack } from '../lib/budgets-stack.ts';

const app = new cdk.App();

new BudgetsStack(app, 'CdkdBudgetsExample', {
  description: 'Minimal AWS::Budgets::Budget with one email-subscriber notification',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
