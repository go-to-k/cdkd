#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SupersededSgDestroyOrderStack } from '../lib/superseded-sg-destroy-order-stack.ts';

const app = new cdk.App();
new SupersededSgDestroyOrderStack(app, 'CdkdSupersededSgDestroyOrderExample', {
  description: 'cdkd integ: an old security group a deploy could not delete goes before the VPC on destroy (issue 7073)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
