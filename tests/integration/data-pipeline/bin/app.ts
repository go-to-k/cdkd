#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DataPipelineStack } from '../lib/data-pipeline-stack.ts';

const app = new cdk.App();
new DataPipelineStack(app, 'DataPipelineStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
