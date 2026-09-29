#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ReplaceSquatterRefusalStack } from '../lib/replace-squatter-refusal-stack.ts';

const app = new cdk.App();
new ReplaceSquatterRefusalStack(app, 'CdkdReplaceSquatterRefusalExample', {
  description: 'cdkd deploy --replace name-holder refusal integ probe (issue #3979)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
