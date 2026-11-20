#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ReplacedQueueTopicFailedRollbackStack } from '../lib/replaced-queue-topic-failed-rollback-stack.ts';

const app = new cdk.App();
new ReplacedQueueTopicFailedRollbackStack(app, 'CdkdReplacedQueueTopicFailedRollbackExample', {
  description: 'cdkd keeps a replaced SQS queue and SNS topic whole when the deploy fails (issue #6712)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
