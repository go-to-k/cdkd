#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VpcLambdaCrRaceStack } from '../lib/vpc-lambda-cr-race-stack';

const app = new cdk.App();
new VpcLambdaCrRaceStack(app, 'CdkdVpcLambdaCrRace', {
  description:
    'Regression test for Pending-Lambda race: VPC-attached Lambda backs a Custom Resource. Pre-fix: deploy fails with "function is currently in the following state: Pending". Post-fix: deploy succeeds.',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
