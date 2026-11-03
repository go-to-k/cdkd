#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcToSdkRerouteEcsServiceStack } from '../lib/cc-to-sdk-reroute-ecs-service-stack.ts';

const app = new cdk.App();
new CcToSdkRerouteEcsServiceStack(app, 'CdkdCcToSdkRerouteEcsServiceExample', {
  description: 'cdkd sticky-CC to SDK re-route integ for AWS::ECS::Service (issue 5654)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
