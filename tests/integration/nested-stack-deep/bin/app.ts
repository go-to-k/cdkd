#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NestedStackDeep } from '../lib/nested-stack-deep.ts';

const app = new cdk.App();
new NestedStackDeep(app, 'NestedStackDeep', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
