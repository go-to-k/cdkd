#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Ec2VpcEndpointStack } from '../lib/ec2-vpc-endpoint-stack.ts';

const app = new cdk.App();
new Ec2VpcEndpointStack(app, 'CdkdEc2VpcEndpointExample', {
  description: 'cdkd VPC endpoint (Interface + Gateway) integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
