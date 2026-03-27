#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { LogPipelineStack } from '../lib/log-pipeline-stack';

const app = new cdk.App();
new LogPipelineStack(app, 'LogPipelineStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
