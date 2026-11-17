#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcToSdkRerouteCommonTypes7Stack } from '../lib/cc-to-sdk-reroute-common-types-7-stack.ts';

const app = new cdk.App();
new CcToSdkRerouteCommonTypes7Stack(app, 'CdkdCcToSdkRerouteCommonTypes7Example', {
  description: 'cdkd sticky-CC to SDK re-route parity integ for API Gateway Authorizer / Stage / Method (issue 6490, batch 7)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
