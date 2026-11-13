#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { StackIdUuidStack } from '../lib/stack-id-uuid-stack.ts';

const app = new cdk.App();
for (const id of ['CdkdStackIdUuidA', 'CdkdStackIdUuidB']) {
  new StackIdUuidStack(app, id, {
    description: 'cdkd AWS::StackId per-stack UUID tail integ (go-to-k/cdkd#6170)',
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  });
}
