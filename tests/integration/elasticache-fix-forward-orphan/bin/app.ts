#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ElastiCacheFixForwardOrphanStack } from '../lib/elasticache-fix-forward-orphan-stack.ts';

const app = new cdk.App();
new ElastiCacheFixForwardOrphanStack(app, 'CdkdElastiCacheFixForwardOrphan', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
