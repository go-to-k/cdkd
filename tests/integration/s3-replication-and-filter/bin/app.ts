#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { S3ReplicationAndFilterStack } from '../lib/s3-replication-and-filter-stack.ts';

const app = new cdk.App();
new S3ReplicationAndFilterStack(app, 'CdkdS3ReplicationAndFilterExample', {
  description: 'cdkd S3 replication combined And filter (prefix + tags) integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
