#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcToSdkRerouteCommonTypes5Stack } from '../lib/cc-to-sdk-reroute-common-types-5-stack.ts';

const app = new cdk.App();
new CcToSdkRerouteCommonTypes5Stack(app, 'CdkdCcToSdkRerouteCommonTypes5Example', {
  description: 'cdkd sticky-CC to SDK re-route parity integ for AWS::ServiceDiscovery::Service in DNS and HTTP namespaces (issue 6454, batch 5)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
