#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BootstrapFreeStack } from '../lib/bootstrap-free-stack.ts';

const app = new cdk.App();
new BootstrapFreeStack(app, 'CdkdBootstrapFreeStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
