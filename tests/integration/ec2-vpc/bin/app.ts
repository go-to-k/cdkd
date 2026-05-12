#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Ec2VpcStack } from '../lib/ec2-vpc-stack.ts';

const app = new cdk.App();
new Ec2VpcStack(app, 'Ec2VpcStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
