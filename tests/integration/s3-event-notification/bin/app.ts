#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { S3EventNotificationStack } from '../lib/s3-event-notification-stack.ts';

const app = new cdk.App();
new S3EventNotificationStack(app, 'CdkdS3EventNotificationExample', {
  description: 'cdkd S3 -> Lambda event notification (Custom::S3BucketNotifications) functional integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
