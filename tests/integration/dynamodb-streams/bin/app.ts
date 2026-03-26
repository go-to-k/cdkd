#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DynamodbStreamsStack } from '../lib/dynamodb-streams-stack';

const app = new cdk.App();
new DynamodbStreamsStack(app, 'DynamodbStreamsStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
