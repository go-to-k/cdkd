#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { KinesisStreamModeSwitchStack } from '../lib/kinesis-stream-mode-switch-stack.ts';

const app = new cdk.App();
new KinesisStreamModeSwitchStack(app, 'CdkdKinesisStreamModeSwitchExample', {
  description: 'cdkd Kinesis StreamMode switch (PROVISIONED <-> ON_DEMAND) integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
