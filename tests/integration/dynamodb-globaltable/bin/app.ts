#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DynamoDBGlobalTableStack } from '../lib/dynamodb-globaltable-stack.ts';

const app = new cdk.App();

new DynamoDBGlobalTableStack(app, 'CdkdDynamoDBGlobalTableExample', {
  description:
    'End-to-end real-AWS test fixture for cdkd AWS::DynamoDB::GlobalTable SDK Provider (Issue #383)',
  env: {
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  },
});
