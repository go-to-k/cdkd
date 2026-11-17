#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcToSdkRerouteCommonTypes4Stack } from '../lib/cc-to-sdk-reroute-common-types-4-stack.ts';

const app = new cdk.App();
new CcToSdkRerouteCommonTypes4Stack(app, 'CdkdCcToSdkRerouteCommonTypes4Example', {
  description: 'cdkd sticky-CC to SDK re-route parity integ for six more resource types (issue 6454, batch 4)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
