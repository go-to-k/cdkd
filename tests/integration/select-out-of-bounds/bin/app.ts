#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SelectOutOfBoundsStack } from '../lib/select-out-of-bounds-stack.ts';

const app = new cdk.App();
new SelectOutOfBoundsStack(app, 'CdkdSelectOutOfBounds', {
  description: 'cdkd out-of-bounds Fn::Select refusal integ (go-to-k/cdkd#6181)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
