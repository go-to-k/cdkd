#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SnsSqsEventStack } from '../lib/sns-sqs-event-stack';

const app = new cdk.App();
new SnsSqsEventStack(app, 'CdkqSnsSqsEventExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
