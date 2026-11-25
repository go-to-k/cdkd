#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SdkToCcIdentifierStack } from '../lib/sdk-to-cc-identifier-stack.ts';

const app = new cdk.App();
new SdkToCcIdentifierStack(app, 'CdkdSdkToCcIdentifier', {
  description:
    'SDK-recorded ApiGateway Deployment moved to Cloud Control by an SDK-unwired property (issue #6976)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
