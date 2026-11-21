#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaAcceleratorConfigStack } from '../lib/lambda-accelerator-config-stack.ts';

const app = new cdk.App();
new LambdaAcceleratorConfigStack(app, 'CdkdLmiGpuAcceleratorExample', {
  description: 'cdkd Lambda Function AcceleratorConfig (issue #6352) integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
