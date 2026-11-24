#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Ec2AssociationReplaceStack } from '../lib/ec2-association-replace-stack.ts';

const app = new cdk.App();
new Ec2AssociationReplaceStack(app, 'CdkdEc2AssociationReplaceExample', {
  description: 'cdkd VPC gateway attachment + route table association replacement integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
