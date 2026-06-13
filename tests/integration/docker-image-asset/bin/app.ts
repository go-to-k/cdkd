#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DockerImageAssetStack } from '../lib/docker-image-asset-stack.ts';

const app = new cdk.App();

new DockerImageAssetStack(app, 'CdkdDockerImageAssetExample', {
  description: 'Fixture stack for cdkd deploy-time Docker image asset (ECR build+push) integ test',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
