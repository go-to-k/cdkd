#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Ec2EipInstanceAssociationStack } from '../lib/ec2-eip-instance-association-stack.ts';

const app = new cdk.App();
new Ec2EipInstanceAssociationStack(app, 'CdkdEc2EipInstanceAssociationExample', {
  description: 'cdkd EIP associated with a running instance in a non-default VPC (issue #6752)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
