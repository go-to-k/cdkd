#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DynamoDBFixForwardOrphanStack } from '../lib/dynamodb-fix-forward-orphan-stack.ts';

const app = new cdk.App();
new DynamoDBFixForwardOrphanStack(app, 'CdkdDynamoDBFixForwardOrphan', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
