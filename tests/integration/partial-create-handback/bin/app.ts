#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PartialCreateHandbackStack } from '../lib/partial-create-handback-stack.ts';

const app = new cdk.App();
new PartialCreateHandbackStack(app, 'CdkdPcHandback', {
  description: 'cdkd partial-create cleanup of a handed-back resource integ probe (issue #4403)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
