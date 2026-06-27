#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EventbridgePipesStack } from '../lib/eventbridge-pipes-stack.ts';

const app = new cdk.App();
new EventbridgePipesStack(app, 'CdkdEventbridgePipesExample', {
  description: 'cdkd EventBridge Pipes (SQS->SNS, CC-API) integ probe',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
