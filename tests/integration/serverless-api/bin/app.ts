#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ServerlessApiStack } from '../lib/serverless-api-stack.ts';

const app = new cdk.App();
new ServerlessApiStack(app, 'ServerlessApiStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
