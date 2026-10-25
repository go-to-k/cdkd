#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { VpcLambdaCrRaceStack } from '../lib/vpc-lambda-cr-race-stack.ts';

const app = new cdk.App();
new VpcLambdaCrRaceStack(app, 'CdkdVpcLambdaCrRace', {
  description:
    'Regression test for Pending-Lambda race: VPC-attached Lambda backs a Custom Resource. Pre-fix: deploy fails with "function is currently in the following state: Pending". Post-fix: deploy succeeds. A second VPC-attached Lambda is an S3 notification destination (Custom::S3BucketNotifications); pre-fix S3 rejects it while it is Pending.',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
