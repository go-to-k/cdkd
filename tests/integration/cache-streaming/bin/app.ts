#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CacheStreamingStack } from '../lib/cache-streaming-stack.ts';

const app = new cdk.App();
new CacheStreamingStack(app, 'CacheStreamingStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
