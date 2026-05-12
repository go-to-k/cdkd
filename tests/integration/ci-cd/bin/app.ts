#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CiCdStack } from '../lib/ci-cd-stack.ts';

const app = new cdk.App();

new CiCdStack(app, 'CiCdStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
