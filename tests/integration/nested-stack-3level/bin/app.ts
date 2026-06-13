#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NestedStack3Level } from '../lib/nested-stack-3level.ts';

const app = new cdk.App();
new NestedStack3Level(app, 'CdkdNestedStack3LevelExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
