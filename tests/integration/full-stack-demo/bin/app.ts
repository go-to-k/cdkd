#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FullStackDemoStack } from '../lib/full-stack-demo-stack';

const app = new cdk.App();
new FullStackDemoStack(app, 'FullStackDemoStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
