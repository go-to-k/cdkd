#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcToSdkRerouteCommonTypesStack } from '../lib/cc-to-sdk-reroute-common-types-stack.ts';

const app = new cdk.App();
new CcToSdkRerouteCommonTypesStack(app, 'CdkdCcToSdkRerouteCommonTypesExample', {
  description: 'cdkd sticky-CC to SDK re-route parity integ for ten common resource types (issue 6454)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
