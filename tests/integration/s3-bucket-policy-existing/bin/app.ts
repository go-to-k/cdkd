#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { S3BucketPolicyExistingStack } from '../lib/s3-bucket-policy-existing-stack.ts';

const app = new cdk.App();
new S3BucketPolicyExistingStack(app, 'CdkdS3BucketPolicyExistingExample', {
  description: 'cdkd S3 BucketPolicy create onto a bucket that already holds a policy (#6109)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
