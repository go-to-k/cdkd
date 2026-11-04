#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Ec2SubnetDns64Stack } from '../lib/ec2-subnet-dns64-stack.ts';

const app = new cdk.App();
new Ec2SubnetDns64Stack(app, 'CdkdEc2SubnetDns64Example', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
