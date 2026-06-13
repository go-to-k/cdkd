#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { S3AssetDeployStack } from '../lib/s3-asset-deploy-stack.ts';

const app = new cdk.App();
new S3AssetDeployStack(app, 'CdkdS3AssetDeployExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
