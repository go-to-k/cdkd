#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NestedStackExample } from '../lib/nested-stack-example.ts';

const app = new cdk.App();
new NestedStackExample(app, 'NestedStackExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
