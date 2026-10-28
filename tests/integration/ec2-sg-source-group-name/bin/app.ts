#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Ec2SgSourceGroupNameStack } from '../lib/ec2-sg-source-group-name-stack.ts';

const app = new cdk.App();
new Ec2SgSourceGroupNameStack(app, 'CdkdEc2SgSourceGroupNameExample', {
  description: 'cdkd inline SecurityGroup ingress SourceSecurityGroupName integ probe (issue #5478)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
