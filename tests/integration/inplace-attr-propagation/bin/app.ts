#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { InplaceAttrPropagationStack } from '../lib/inplace-attr-propagation-stack.ts';

const app = new cdk.App();
new InplaceAttrPropagationStack(app, 'CdkdInplaceAttrPropagationExample', {
  description: 'cdkd in-place upstream-attribute propagation integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
