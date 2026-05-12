#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SnsSqsEventStack } from '../lib/sns-sqs-event-stack.ts';

const app = new cdk.App();
new SnsSqsEventStack(app, 'CdkdSnsSqsEventExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
