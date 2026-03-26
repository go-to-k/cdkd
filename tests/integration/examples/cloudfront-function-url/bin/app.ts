#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CloudFrontFunctionUrlStack } from '../lib/cloudfront-function-url-stack';

const app = new cdk.App();
new CloudFrontFunctionUrlStack(app, 'CloudFrontFunctionUrlStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
