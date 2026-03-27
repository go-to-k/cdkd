#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ServerlessApiStack } from '../lib/serverless-api-stack';

const app = new cdk.App();
new ServerlessApiStack(app, 'ServerlessApiStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
