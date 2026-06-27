#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DynamodbTtlAttrChangeStack } from '../lib/dynamodb-ttl-attr-change-stack.ts';

const app = new cdk.App();
new DynamodbTtlAttrChangeStack(app, 'CdkdDynamodbTtlAttrChangeExample', {
  description: 'cdkd DynamoDB TTL AttributeName-change actionable-error integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
