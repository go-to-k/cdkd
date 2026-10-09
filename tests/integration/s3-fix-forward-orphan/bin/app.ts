#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { S3FixForwardOrphanStack } from '../lib/s3-fix-forward-orphan-stack.ts';

const app = new cdk.App();
new S3FixForwardOrphanStack(app, 'CdkdS3FixForwardOrphan', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
