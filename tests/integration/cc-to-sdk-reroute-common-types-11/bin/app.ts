#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcToSdkRerouteCommonTypes11Stack } from '../lib/cc-to-sdk-reroute-common-types-11-stack.ts';

const app = new cdk.App();
new CcToSdkRerouteCommonTypes11Stack(app, 'CdkdCcToSdkRerouteCommonTypes11Example', {
  description:
    'cdkd sticky-CC to SDK re-route parity integ for RDS DBProxy and DBProxyEndpoint (issue 6490, batch 11)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
