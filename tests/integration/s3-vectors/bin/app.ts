#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { S3VectorsStack } from '../lib/s3-vectors-stack';

const app = new cdk.App();

new S3VectorsStack(app, 'S3VectorsStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'S3 Vectors cdkd example with S3 Vector Bucket',
});
