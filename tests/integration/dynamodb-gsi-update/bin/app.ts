#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DynamodbGsiUpdateStack } from '../lib/dynamodb-gsi-update-stack.ts';

const app = new cdk.App();
new DynamodbGsiUpdateStack(app, 'CdkdDynamodbGsiUpdateExample', {
  description: 'cdkd DynamoDB add-a-GSI in-place UPDATE integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
