#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { TypeChangeReplacementStack } from '../lib/type-change-replacement-stack.ts';

const app = new cdk.App();
new TypeChangeReplacementStack(app, 'CdkdTypeChangeReplacementExample', {
  description: 'cdkd resource Type change on an existing logical id (#2668, #3036)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
