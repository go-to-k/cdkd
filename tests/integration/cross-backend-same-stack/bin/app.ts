#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CrossBackendSameStack } from '../lib/cross-backend-same-stack-stack.ts';

const app = new cdk.App();
new CrossBackendSameStack(app, 'Cdkd4705Verify', {
  description: 'cdkd #4705 integ probe: one stack name deployed under two state prefixes',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
