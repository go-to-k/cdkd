#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcToSdkRerouteHostedZoneStack } from '../lib/cc-to-sdk-reroute-hosted-zone-stack.ts';

const app = new cdk.App();
new CcToSdkRerouteHostedZoneStack(app, 'CdkdCcToSdkRerouteHostedZoneExample', {
  description: 'cdkd sticky-CC to SDK re-route parity integ for AWS::Route53::HostedZone (issue 5641)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
