#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Ec2VpcIpamStack } from '../lib/ec2-vpc-ipam-stack.ts';

const app = new cdk.App();
new Ec2VpcIpamStack(app, 'CdkdEc2VpcIpamExample', {
  description: 'cdkd AWS::EC2::VPC CIDR allocated from an IPAM pool integ probe (issue #5633)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
