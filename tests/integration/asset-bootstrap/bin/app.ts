#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AssetBootstrapStack } from '../lib/asset-bootstrap-stack.ts';

const app = new cdk.App();
new AssetBootstrapStack(app, 'CdkdAssetBootstrapStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
