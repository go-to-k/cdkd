#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ReplacementImmutableNameStack } from '../lib/replacement-immutable-name-stack.ts';

const app = new cdk.App();
new ReplacementImmutableNameStack(app, 'CdkdReplacementImmutableNameExample', {
  description: 'cdkd immutable-Name replacement integ (Kinesis Stream + Secret)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
