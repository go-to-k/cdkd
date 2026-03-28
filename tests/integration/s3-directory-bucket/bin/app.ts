#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { S3DirectoryBucketStack } from '../lib/s3-directory-bucket-stack';

const app = new cdk.App();

new S3DirectoryBucketStack(app, 'CdkdS3DirectoryBucketExample', {
  description: 'S3 Express Directory Bucket example for cdkd',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
