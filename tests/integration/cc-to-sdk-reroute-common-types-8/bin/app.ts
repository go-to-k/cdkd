#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcToSdkRerouteCommonTypes8Stack } from '../lib/cc-to-sdk-reroute-common-types-8-stack.ts';

const app = new cdk.App();
new CcToSdkRerouteCommonTypes8Stack(app, 'CdkdCcToSdkRerouteCommonTypes8Example', {
  description:
    'cdkd sticky-CC to SDK re-route parity integ for API Gateway v2 Stage / Integration / Route / Authorizer, AppSync GraphQLApi and S3 Vectors VectorBucket (issue 6490, batch 8)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
