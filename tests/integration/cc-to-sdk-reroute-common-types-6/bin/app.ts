#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcToSdkRerouteCommonTypes6Stack } from '../lib/cc-to-sdk-reroute-common-types-6-stack.ts';

const app = new cdk.App();
new CcToSdkRerouteCommonTypes6Stack(app, 'CdkdCcToSdkRerouteCommonTypes6Example', {
  description: 'cdkd sticky-CC to SDK re-route parity integ for S3 Tables TableBucket and AgentCore Runtime / Evaluator (issue 6490, batch 6)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
