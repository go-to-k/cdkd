#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { FirehoseMskSourceStack } from '../lib/firehose-msk-source-stack.ts';

const app = new cdk.App();
new FirehoseMskSourceStack(app, 'CdkdFirehoseMskSourceExample', {
  description: 'cdkd Firehose MSKSourceConfiguration SDK-route integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
