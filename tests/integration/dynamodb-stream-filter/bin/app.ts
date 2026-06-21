#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DynamodbStreamFilterStack } from '../lib/dynamodb-stream-filter-stack.ts';

const app = new cdk.App();
new DynamodbStreamFilterStack(app, 'CdkdDynamodbStreamFilterExample', {
  description: 'cdkd DynamoDB stream -> Lambda event source with FilterCriteria integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
