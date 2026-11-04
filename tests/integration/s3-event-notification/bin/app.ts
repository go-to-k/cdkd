#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {
  S3EventNotificationConsumerStack,
  S3EventNotificationStack,
} from '../lib/s3-event-notification-stack.ts';

const app = new cdk.App();
new S3EventNotificationStack(app, 'CdkdS3EventNotificationExample', {
  description: 'cdkd S3 -> Lambda event notification (Custom::S3BucketNotifications) functional integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

// go-to-k/cdkd#5741: imports the shared bucket by name and adds a notification.
new S3EventNotificationConsumerStack(app, 'CdkdS3EventNotificationConsumer', {
  description: 'cdkd cross-stack fromBucketName(...).addEventNotification consumer (#5741)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
