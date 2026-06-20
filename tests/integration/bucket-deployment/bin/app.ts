#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BucketDeploymentStack } from '../lib/bucket-deployment-stack.ts';

const app = new cdk.App();
new BucketDeploymentStack(app, 'CdkdBucketDeploymentExample', {
  description: 'cdkd BucketDeployment (Custom::CDKBucketDeployment) functional integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
