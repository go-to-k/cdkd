#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { S3AutoDeleteObjectsDisableStack } from '../lib/s3-autodelete-objects-disable-stack.ts';

const app = new cdk.App();
new S3AutoDeleteObjectsDisableStack(app, 'CdkdS3AutoDeleteDisableExample', {
  description: 'cdkd autoDeleteObjects true->false on an untagged bucket integ (issue #6422)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
