#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { FallbackRecreateChildrenStack } from '../lib/fallback-recreate-children-stack.ts';

const app = new cdk.App();
new FallbackRecreateChildrenStack(app, 'CdkdFallbackRecreateChildrenExample', {
  description: 'cdkd re-creates the children of an update-failure fallback re-create (issue #4444)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
