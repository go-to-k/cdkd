#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { S3LifecycleStack } from '../lib/s3-lifecycle-stack.ts';

const app = new cdk.App();
new S3LifecycleStack(app, 'CdkdS3LifecycleExample', {
  description: 'cdkd S3 lifecycle V1/V2 normalization integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
