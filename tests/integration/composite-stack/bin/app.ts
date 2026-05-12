#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CompositeStack } from '../lib/composite-stack.ts';

const app = new cdk.App();
new CompositeStack(app, 'CdkdCompositeStackExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
