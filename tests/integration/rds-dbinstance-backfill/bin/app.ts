#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {
  RdsDbInstanceBackfillStack,
  RdsDbInstanceBackfillXrSourceStack,
} from '../lib/rds-dbinstance-backfill-stack.ts';

const app = new cdk.App();
new RdsDbInstanceBackfillStack(app, 'RdsDbInstanceBackfillStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
// go-to-k/cdkd#5640 (SourceRegion): the cross-region read replica's source
// lives in a stack of its own, in the region verify.sh names; defined only
// then, so a plain synth stays one stack.
const xrSourceRegion = process.env.CDKD_TEST_XR_SOURCE_REGION;
if (xrSourceRegion !== undefined && xrSourceRegion !== '') {
  new RdsDbInstanceBackfillXrSourceStack(app, 'RdsDbInstanceBackfillXrSourceStack', {
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: xrSourceRegion,
    },
  });
}
