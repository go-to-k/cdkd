#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApigwRestApiSpecStack } from '../lib/apigw-restapi-spec-stack.ts';

const app = new cdk.App();
new ApigwRestApiSpecStack(app, 'CdkdApigwRestApiSpec', {
  description: 'cdkd AWS::ApiGateway::RestApi SDK provider integ (go-to-k/cdkd#6139)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
