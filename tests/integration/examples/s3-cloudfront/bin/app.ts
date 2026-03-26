#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { S3CloudFrontStack } from '../lib/s3-cloudfront-stack';

const app = new cdk.App();
new S3CloudFrontStack(app, 'S3CloudFrontStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
