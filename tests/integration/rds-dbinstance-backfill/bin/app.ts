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
// lives in a stack of its own, in the region verify.sh names, under the name
// it derives from the run's region; defined only then, so a plain synth stays
// one stack.
const xrSourceRegion = process.env.CDKD_TEST_XR_SOURCE_REGION;
const xrStackName = process.env.CDKD_TEST_XR_STACK;
if (xrSourceRegion !== undefined && xrSourceRegion !== '') {
  if (xrStackName === undefined || xrStackName === '') {
    throw new Error('CDKD_TEST_XR_STACK must be set with CDKD_TEST_XR_SOURCE_REGION');
  }
  new RdsDbInstanceBackfillXrSourceStack(app, xrStackName, {
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: xrSourceRegion,
    },
  });
}
