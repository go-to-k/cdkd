#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ScrubNestedChildStack } from '../lib/scrub-nested-child-stack.ts';

const app = new cdk.App();
new ScrubNestedChildStack(app, 'CdkdScrubNestedChildVerify', {
  description:
    'cdkd integ - cdkd scrub repairs a nested-stack child record through its parent (issue #2252)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
