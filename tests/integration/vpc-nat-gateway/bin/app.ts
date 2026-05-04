#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VpcNatGatewayStack } from '../lib/vpc-nat-gateway-stack';

const app = new cdk.App();
new VpcNatGatewayStack(app, 'CdkdVpcNatGateway', {
  description:
    'Integration test for AWS::EC2::NatGateway SDK provider — exercises CreateNatGateway + waitUntilNatGatewayAvailable on deploy and DeleteNatGateway + waitUntilNatGatewayDeleted on destroy. Pass --no-wait to skip both stabilization waits.',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
