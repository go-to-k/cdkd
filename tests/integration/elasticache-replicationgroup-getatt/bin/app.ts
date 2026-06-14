#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ElastiCacheRgStack } from '../lib/elasticache-rg-stack.ts';

const app = new cdk.App();
new ElastiCacheRgStack(app, 'CdkdElastiCacheRgExample', {
  env: { region: process.env.AWS_REGION ?? 'us-east-1' },
});
