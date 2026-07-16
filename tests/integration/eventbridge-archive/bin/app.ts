#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EventbridgeArchiveStack } from '../lib/eventbridge-archive-stack.ts';

const app = new cdk.App();
new EventbridgeArchiveStack(app, 'CdkdEventbridgeArchiveExample', {
  description: 'cdkd EventBridge custom bus + Archive integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
