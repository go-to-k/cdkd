#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { StreamDeleteRedeployStack } from '../lib/stream-delete-redeploy-stack.ts';

const app = new cdk.App();
new StreamDeleteRedeployStack(app, 'CdkdStreamDeleteRedeployExample', {
  description: 'cdkd Kinesis + Firehose destroy-then-immediate-redeploy integ probe (issue #3872)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
