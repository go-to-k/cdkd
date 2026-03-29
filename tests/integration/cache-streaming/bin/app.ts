#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CacheStreamingStack } from '../lib/cache-streaming-stack';

const app = new cdk.App();
new CacheStreamingStack(app, 'CacheStreamingStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
