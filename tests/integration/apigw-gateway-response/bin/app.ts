#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApigwGatewayResponseStack } from '../lib/apigw-gateway-response-stack.ts';

const app = new cdk.App();
new ApigwGatewayResponseStack(app, 'CdkdApigwGatewayResponseExample', {
  description: 'cdkd API Gateway GatewayResponse (4xx/5xx CORS headers) integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
