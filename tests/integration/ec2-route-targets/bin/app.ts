#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Ec2RouteTargetsStack } from '../lib/ec2-route-targets-stack.ts';

const app = new cdk.App();
new Ec2RouteTargetsStack(app, 'CdkdEc2RouteTargetsExample', {
  description:
    'AWS::EC2::Route extra target types: prefix-list destination + Transit Gateway target (issue #609 backfill)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
