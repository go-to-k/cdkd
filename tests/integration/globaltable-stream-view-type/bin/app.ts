#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GlobalTableStreamViewTypeStack } from '../lib/globaltable-stream-view-type-stack.ts';

const app = new cdk.App();
new GlobalTableStreamViewTypeStack(app, 'CdkdGlobalTableStreamViewType', {
  description: 'cdkd GlobalTable stream view type change with a Lambda consumer (issue #7000)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
