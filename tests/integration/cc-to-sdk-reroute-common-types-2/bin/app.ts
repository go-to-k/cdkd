#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcToSdkRerouteCommonTypes2Stack } from '../lib/cc-to-sdk-reroute-common-types-2-stack.ts';

const app = new cdk.App();
new CcToSdkRerouteCommonTypes2Stack(app, 'CdkdCcToSdkRerouteCommonTypes2Example', {
  description: 'cdkd sticky-CC to SDK re-route parity integ for eleven more common resource types (issue 6454, batch 2)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
