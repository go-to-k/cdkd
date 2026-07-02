#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DynamodbTableclassSwitchStack } from '../lib/dynamodb-tableclass-switch-stack.ts';

const app = new cdk.App();
new DynamodbTableclassSwitchStack(app, 'CdkdDynamodbTableclassSwitchExample', {
  description: 'cdkd DynamoDB TableClass switch (STANDARD <-> STANDARD_INFREQUENT_ACCESS) integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
