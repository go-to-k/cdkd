#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CrossRegionStateBucketStack } from '../lib/cross-region-state-bucket-stack';

const app = new cdk.App();

new CrossRegionStateBucketStack(app, 'CdkdCrossRegionStateBucketExample', {
  description: 'Verifies cdkd works when the state bucket is in a different region than the CLI region',
});
