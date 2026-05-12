#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Ec2InstanceStack } from '../lib/ec2-instance-stack.ts';

const app = new cdk.App();
new Ec2InstanceStack(app, 'Ec2InstanceStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
