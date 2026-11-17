#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcToSdkRerouteCommonTypes10Stack } from '../lib/cc-to-sdk-reroute-common-types-10-stack.ts';

const app = new cdk.App();
new CcToSdkRerouteCommonTypes10Stack(app, 'CdkdCcToSdkRerouteCommonTypes10Example', {
  description:
    'cdkd sticky-CC to SDK re-route parity integ for WAFv2 WebACL (REGIONAL and CLOUDFRONT) and CodeCommit Repository (issue 6490, batch 10)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
