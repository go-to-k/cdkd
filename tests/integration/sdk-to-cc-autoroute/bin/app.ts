#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SdkToCcAutorouteStack } from '../lib/sdk-to-cc-autoroute-stack.ts';

const app = new cdk.App();
new SdkToCcAutorouteStack(app, 'CdkdSdkToCcAutorouteExample', {
  description: 'cdkd SDK -> Cloud Control auto-route on a still-SDK resource (issue 2744)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
