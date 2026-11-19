#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcToSdkRerouteCommonTypes12Stack } from '../lib/cc-to-sdk-reroute-common-types-12-stack.ts';

const app = new cdk.App();
new CcToSdkRerouteCommonTypes12Stack(app, 'CdkdCcToSdkRerouteCommonTypes12Example', {
  description:
    'cdkd sticky-CC to SDK re-route parity integ for Events Archive and the Logs delivery types (issue 6588)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
