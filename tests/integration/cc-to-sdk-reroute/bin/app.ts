#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcToSdkRerouteStack } from '../lib/cc-to-sdk-reroute-stack.ts';

const app = new cdk.App();
new CcToSdkRerouteStack(app, 'CdkdCcToSdkRerouteExample', {
  description: 'cdkd sticky-CC to SDK re-route parity integ (issue 2719)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
