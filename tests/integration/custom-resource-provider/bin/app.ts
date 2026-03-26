#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CustomResourceProviderStack } from '../lib/custom-resource-provider-stack';

const app = new cdk.App();
new CustomResourceProviderStack(app, 'CustomResourceProviderStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
