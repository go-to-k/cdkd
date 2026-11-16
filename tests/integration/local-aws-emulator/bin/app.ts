#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalAwsEmulatorStack } from '../lib/local-aws-emulator-stack.ts';

const app = new cdk.App();
new LocalAwsEmulatorStack(app, 'CdkdLocalAwsEmulatorExample', {
  description: 'cdkd --aws-emulator loop integ probe (deploy, cdkd local, update, destroy)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
