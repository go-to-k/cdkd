#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CustomResourceProviderStack } from '../lib/custom-resource-provider-stack.ts';

const app = new cdk.App();
new CustomResourceProviderStack(app, 'CustomResourceProviderStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
