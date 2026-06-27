#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DynamodbAutoscalingStack } from '../lib/dynamodb-autoscaling-stack.ts';

const app = new cdk.App();
new DynamodbAutoscalingStack(app, 'CdkdDynamodbAutoscalingExample', {
  description:
    'cdkd DynamoDB provisioned table + Application Auto Scaling (CC-API) integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
