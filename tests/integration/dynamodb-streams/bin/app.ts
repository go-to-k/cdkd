#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DynamodbStreamsStack } from '../lib/dynamodb-streams-stack.ts';
import { DynamodbStreamMembersStack } from '../lib/dynamodb-stream-members-stack.ts';

const app = new cdk.App();
new DynamodbStreamsStack(app, 'DynamodbStreamsStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
new DynamodbStreamMembersStack(app, 'DynamodbStreamMembersStack', {
  description: 'cdkd DynamoDB StreamSpecification.ResourcePolicy / Tags integ probe (issue #3458)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
