#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcToSdkRerouteVpcEndpointStack } from '../lib/cc-to-sdk-reroute-vpc-endpoint-stack.ts';

const app = new cdk.App();
new CcToSdkRerouteVpcEndpointStack(app, 'CdkdCcToSdkRerouteVpcEndpointExample', {
  description: 'cdkd sticky-CC to SDK re-route parity integ for AWS::EC2::VPCEndpoint (issue 6943)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
