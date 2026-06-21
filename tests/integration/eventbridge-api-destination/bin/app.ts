#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EventbridgeApiDestinationStack } from '../lib/eventbridge-api-destination-stack.ts';

const app = new cdk.App();
new EventbridgeApiDestinationStack(app, 'CdkdEventbridgeApiDestinationExample', {
  description: 'cdkd EventBridge Connection Arn GetAtt enrichment integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
