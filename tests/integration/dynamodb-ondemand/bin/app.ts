#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DynamodbOndemandStack } from '../lib/dynamodb-ondemand-stack.ts';

const app = new cdk.App();
new DynamodbOndemandStack(app, 'CdkdDynamodbOndemandExample', {
  description: 'cdkd DynamoDB OnDemandThroughput backfill integ probe (#609)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
