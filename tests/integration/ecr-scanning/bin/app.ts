#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EcrScanningStack } from '../lib/ecr-scanning-stack.ts';

const app = new cdk.App();
new EcrScanningStack(app, 'CdkdEcrScanningExample', {
  description: 'cdkd ECR ImageScanningConfiguration casing integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
