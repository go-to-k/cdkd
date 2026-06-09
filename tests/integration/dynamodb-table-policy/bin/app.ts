#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DynamodbTablePolicyStack } from '../lib/dynamodb-table-policy-stack.ts';

const app = new cdk.App();
new DynamodbTablePolicyStack(app, 'CdkdDynamodbTablePolicyExample', {
  description:
    'cdkd DynamoDB Table ResourcePolicy/KinesisStreamSpecification/ContributorInsightsSpecification backfill integ probe (#609)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
