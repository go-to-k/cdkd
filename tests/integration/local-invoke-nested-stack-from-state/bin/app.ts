#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeNestedStackFromStateStack } from '../lib/local-invoke-nested-stack-from-state-stack.ts';

const app = new cdk.App();

new LocalInvokeNestedStackFromStateStack(app, 'CdkdLocalInvokeNestedStackFromStateExample', {
  description: 'Fixture stack for cdkd local --from-state against resources inside NestedStacks',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
