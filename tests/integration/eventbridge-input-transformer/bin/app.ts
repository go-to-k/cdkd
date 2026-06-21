#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EventbridgeInputTransformerStack } from '../lib/eventbridge-input-transformer-stack.ts';

const app = new cdk.App();
new EventbridgeInputTransformerStack(app, 'CdkdEventbridgeInputTransformerExample', {
  description: 'cdkd EventBridge Rule with target InputTransformer integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
