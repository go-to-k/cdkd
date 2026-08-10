#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { S3SubconfigRemovalStack } from '../lib/s3-subconfig-removal-stack.ts';

const app = new cdk.App();
new S3SubconfigRemovalStack(app, 'CdkdS3SubconfigRemovalExample', {
  description: 'cdkd S3 sub-config removal semantics integ probe (issue #1466)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
