#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OrphanResourceStack } from '../lib/orphan-resource-stack.ts';

const app = new cdk.App();

new OrphanResourceStack(app, 'CdkdOrphanResourceExample', {
  description:
    'Integration test for `cdkd orphan` per-resource — Lambda env var Refs an S3 bucket; the bucket is the orphan target',
});
