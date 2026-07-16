#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AssetAutoCreateStack } from '../lib/asset-auto-create-stack.ts';

const app = new cdk.App();
new AssetAutoCreateStack(app, 'CdkdAssetAutoCreateStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
