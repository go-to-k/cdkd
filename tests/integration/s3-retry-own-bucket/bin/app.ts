#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { S3RetryOwnBucketStack } from '../lib/s3-retry-own-bucket-stack.ts';

const app = new cdk.App();
new S3RetryOwnBucketStack(app, 'CdkdS3RetryOwnBucket', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
