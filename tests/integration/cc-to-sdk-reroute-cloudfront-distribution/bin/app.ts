#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcToSdkRerouteCloudFrontDistributionStack } from '../lib/cc-to-sdk-reroute-cloudfront-distribution-stack.ts';

const app = new cdk.App();
new CcToSdkRerouteCloudFrontDistributionStack(app, 'CdkdCcToSdkRerouteCloudFrontDistributionExample', {
  description:
    'cdkd sticky-CC to SDK re-route parity integ for CloudFront Distribution (issue 6490, batch 11)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
