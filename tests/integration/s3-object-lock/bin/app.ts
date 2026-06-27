#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { S3ObjectLockStack } from '../lib/s3-object-lock-stack.ts';

const app = new cdk.App();
new S3ObjectLockStack(app, 'CdkdS3ObjectLockExample', {
  description: 'cdkd S3 Object Lock default retention integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
