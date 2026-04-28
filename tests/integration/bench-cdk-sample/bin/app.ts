#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BenchCdkSampleStack } from '../lib/bench-cdk-sample-stack';

const app = new cdk.App();

new BenchCdkSampleStack(app, 'CdkdBenchCdkSample', {
  description:
    'cdkd integ test mirroring cfn-deployment-speed-beta-toolkit/cdk-sample (VPC + Lambda x2 + SQS + Function URL + CloudFront)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
