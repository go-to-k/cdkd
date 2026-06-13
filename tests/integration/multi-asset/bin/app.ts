#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MultiAssetStack } from '../lib/multi-asset-stack.ts';

const app = new cdk.App();

new MultiAssetStack(app, 'CdkdMultiAssetExample', {
  description:
    'Fixture stack for cdkd multi-asset publishing (1 Docker/ECR image + 3 distinct S3 zip assets + 1 generic S3 asset, all in one deploy)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
