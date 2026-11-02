#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ElastiCacheSnapshotArnsStack } from '../lib/elasticache-snapshot-arns-stack.ts';

const app = new cdk.App();
new ElastiCacheSnapshotArnsStack(app, 'CdkdElastiCacheSnapshotArnsExample', {
  description: 'cdkd ElastiCache CacheCluster SnapshotArns SDK-route integ probe (issue #5635)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
