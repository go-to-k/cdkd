#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcToSdkRerouteRestApiStack } from '../lib/cc-to-sdk-reroute-rest-api-stack.ts';

const app = new cdk.App();
new CcToSdkRerouteRestApiStack(app, 'CdkdCcToSdkRerouteRestApiExample', {
  description: 'cdkd sticky-CC to SDK re-route parity integ for AWS::ApiGateway::RestApi (issue 6141)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
