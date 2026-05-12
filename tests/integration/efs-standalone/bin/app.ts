#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EfsStandaloneStack } from '../lib/efs-standalone-stack.ts';

const app = new cdk.App();
new EfsStandaloneStack(app, 'EfsStandaloneStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
