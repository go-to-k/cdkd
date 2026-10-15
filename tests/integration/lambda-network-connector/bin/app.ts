#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaNetworkConnectorStack } from '../lib/lambda-network-connector-stack.ts';

const app = new cdk.App();
new LambdaNetworkConnectorStack(app, 'CdkdLambdaNetworkConnectorExample', {
  description: 'cdkd Lambda network connector SDK provider integ (go-to-k/cdkd#4928)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
