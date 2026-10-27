#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApigwVpclinkIntegrationTargetStack } from '../lib/apigw-vpclink-integration-target-stack.ts';

const app = new cdk.App();
new ApigwVpclinkIntegrationTargetStack(app, 'CdkdApigwVpclinkIntegrationTargetExample', {
  description: 'cdkd API Gateway REST private integration (VPC link v2 IntegrationTarget) integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
