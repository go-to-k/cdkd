#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcToSdkRerouteCommonTypes3Stack } from '../lib/cc-to-sdk-reroute-common-types-3-stack.ts';

const app = new cdk.App();
new CcToSdkRerouteCommonTypes3Stack(app, 'CdkdCcToSdkRerouteCommonTypes3Example', {
  description: 'cdkd sticky-CC to SDK re-route parity integ for five more resource types (issue 6454, batch 3)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
