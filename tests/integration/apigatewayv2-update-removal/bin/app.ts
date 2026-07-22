#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApiGatewayV2UpdateRemovalStack } from '../lib/apigatewayv2-update-removal-stack.ts';

const app = new cdk.App();
new ApiGatewayV2UpdateRemovalStack(app, 'CdkdApiGatewayV2UpdateRemovalExample', {
  description: 'cdkd ApiGatewayV2 update-field removal reset (issue #1160) integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
