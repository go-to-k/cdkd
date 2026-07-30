#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Ec2InstanceFanoutStack } from '../lib/fanout-stack.ts';

const app = new cdk.App();
new Ec2InstanceFanoutStack(app, 'Ec2InstanceFanoutStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
