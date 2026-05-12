#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApiGatewayStack } from '../lib/apigateway-stack.ts';

const app = new cdk.App();
new ApiGatewayStack(app, 'ApiGatewayStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
