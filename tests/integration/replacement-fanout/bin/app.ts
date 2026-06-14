#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ReplacementFanoutStack } from '../lib/replacement-fanout-stack.ts';

const app = new cdk.App();

// env is required because the stack derives globally-unique physical names
// (the SNS TopicName) from the region. account + region come from the standard
// CDK_DEFAULT_* env vars cdkd's synthesis layer sets.
new ReplacementFanoutStack(app, 'CdkdReplacementFanoutExample', {
  description: 'cdkd replacement fan-out propagation example (issue #807, fan-out scale)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
