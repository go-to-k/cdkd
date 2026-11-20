#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SdkUnmodelledNestedRouteStack } from '../lib/sdk-unmodelled-nested-route-stack.ts';

const app = new cdk.App();
new SdkUnmodelledNestedRouteStack(app, 'CdkdSdkUnmodelledNestedRouteExample', {
  description: 'cdkd Cloud Control route for nested members the AWS SDK does not model (issue 6690)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
