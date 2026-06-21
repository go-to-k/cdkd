#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaLayerVersionUpdateStack } from '../lib/lambda-layer-version-update-stack.ts';

const app = new cdk.App();
new LambdaLayerVersionUpdateStack(app, 'CdkdLambdaLayerVersionUpdateExample', {
  description: 'cdkd Lambda LayerVersion content-change replacement integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
