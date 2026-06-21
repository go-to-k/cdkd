#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DynamodbSseStack } from '../lib/dynamodb-sse-stack.ts';

const app = new cdk.App();
new DynamodbSseStack(app, 'CdkdDynamodbSseExample', {
  description: 'cdkd DynamoDB SSESpecification mapping integ',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
