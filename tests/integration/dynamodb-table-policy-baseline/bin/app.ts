#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DynamoDBTablePolicyBaselineStack } from '../lib/dynamodb-table-policy-baseline-stack.ts';

const app = new cdk.App();
new DynamoDBTablePolicyBaselineStack(app, 'CdkdDynamoDBTablePolicyBaselineExample', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
