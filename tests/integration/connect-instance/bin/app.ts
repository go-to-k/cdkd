#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ConnectInstanceStack } from '../lib/connect-instance-stack.ts';

const app = new cdk.App();
new ConnectInstanceStack(app, 'CdkdConnectInstanceExample', {
  description: 'cdkd Amazon Connect instance + storage config integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
