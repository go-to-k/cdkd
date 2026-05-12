#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { S3TablesStack } from '../lib/s3-tables-stack.ts';

const app = new cdk.App();

new S3TablesStack(app, 'S3TablesStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
